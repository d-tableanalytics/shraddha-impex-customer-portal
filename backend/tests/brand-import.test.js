/**
 * A brand created at runtime, then stocked through the Inventory Master import.
 *
 * The import has three ways of deciding a row's brand, and each must land the
 * SKU — and its stock — under the new brand, never under Koken:
 *
 *   1. A NEW SKU, brand chosen on the upload form.
 *   2. A NEW SKU, brand answered in the new-SKU prompt (any case).
 *   3. An EXISTING SKU of the new brand, brand resolved from the catalogue.
 *
 * Checked end to end against a transactional database: the product document,
 * the ledger movement and the stock balance all carry the new brand.
 */

import test, { before, after, beforeEach, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

import { startTestReplSet, stopTestMongo, clearCollections } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});
mock.module(new URL('../utils/mailer.js', import.meta.url).href, {
  namedExports: { sendEmail: async () => true },
});

const { default: Location } = await import('../models/Location.js');
const { default: InventoryConfig } = await import('../models/InventoryConfig.js');
const { default: StockBalance } = await import('../models/StockBalance.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { Product, createProductModel } = await import('../models/Product.js');
const { seedBrands } = await import('../utils/brandRegistry.js');
const { createBrand } = await import('../modules/inventory/brand.controller.js');
const { createImportJob, setNewSkuDetails, confirmJob, getJob } = await import('../modules/inventory/import.service.js');

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };
const INVENTORY_MANAGER = { _id: new mongoose.Types.ObjectId(), role: 'Inventory Manager', brandAccess: {} };

before(async () => { await startTestReplSet(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  await InventoryConfig.create({ scope: 'global', effectiveFrom: new Date(0) });
  const res = { status: () => res, json: () => res };
  await createBrand({ body: { name: 'Stanley Tools' }, user: ADMIN, app: { get: () => null } }, res, (e) => { throw e; });
});

const csv = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-import-'));
  const file = path.join(dir, 'master.csv');
  fs.writeFileSync(file, [['SKU Code', 'MSIL Code', 'Quantity', 'Box No'], ...rows].map((r) => r.join(',')).join('\n'));
  return file;
};

const stage = async (rows, { brand = null, actor = ADMIN } = {}) => {
  const filePath = csv(rows);
  return createImportJob({
    filePath, fileName: 'master.csv', fileType: 'csv', fileSize: fs.statSync(filePath).size,
    importType: 'inventory-master', brand, actor, req: null,
  });
};

const answer = (job, brands, actor = ADMIN) => setNewSkuDetails({
  jobId: job.jobId,
  actor,
  req: null,
  entries: job.newSkus.map((s) => ({
    skuCode: s.skuCode,
    brand: brands[s.skuCode] ?? s.brand,
    availableStock: s.availableStock ?? 0,
    moq: 1, leadTime: 30, safetyFactor: 1.2, boxNo: `B-${s.skuCode}`,
  })),
});

const run = async (job, actor = ADMIN) => {
  await confirmJob({ jobId: job.jobId, actor, req: null });
  for (let i = 0; i < 200; i += 1) {
    const j = await getJob(job.jobId);
    if (j.status !== 'Processing') return j;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  throw new Error('import did not finish');
};

const where = async (skuCode) => {
  const [products, balance, movements] = await Promise.all([
    Product.find({ skuCode }, 'brand availableForSale totalAvailableQuantity').lean(),
    StockBalance.findOne({ skuCode }).lean(),
    StockMovement.find({ skuCode }, 'brand quantity').lean(),
  ]);
  return { products, balance, movements };
};

describe('Inventory Master import with a brand created at runtime', () => {
  test('a new SKU takes the brand chosen on the upload form', async () => {
    const job = await stage([['ST-NEW-1', '', '20', '']], { brand: 'Stanley Tools' });
    assert.equal(job.validRows, 1, JSON.stringify(job.fileErrors));
    assert.equal(job.newSkus[0].brand, 'Stanley Tools');

    await answer(job, {});
    const done = await run(job);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));

    const { products, balance, movements } = await where('ST-NEW-1');
    assert.deepEqual(products.map((p) => p.brand), ['Stanley Tools']);
    assert.equal(balance.brand, 'Stanley Tools');
    assert.equal(balance.onHand, 20);
    assert.ok(movements.length > 0);
    assert.ok(movements.every((m) => m.brand === 'Stanley Tools'));
  });

  test('a new SKU takes the brand answered in the prompt, in any case', async () => {
    const job = await stage([['ST-NEW-2', '', '7', '']]);
    assert.equal(job.newSkus[0].brand, null);

    await answer(job, { 'ST-NEW-2': 'stanley tools' });
    const done = await run(job);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));

    const { products, balance } = await where('ST-NEW-2');
    assert.deepEqual(products.map((p) => p.brand), ['Stanley Tools']);
    assert.equal(balance.brand, 'Stanley Tools');
    assert.equal(balance.onHand, 7);
  });

  test('an existing SKU of the new brand gets its stock added under that brand', async () => {
    const first = await stage([['ST-OLD', '', '10', '']], { brand: 'Stanley Tools' });
    await answer(first, {});
    await run(first);

    // Second file: no brand on the form, no Brand column — resolved from the SKU.
    const job = await stage([['ST-OLD', '', '5', '']]);
    assert.equal(job.newSkus.length, 0);
    const done = await run(job);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));

    const { products, balance } = await where('ST-OLD');
    assert.deepEqual(products.map((p) => p.brand), ['Stanley Tools']);
    assert.equal(balance.onHand, 15);
    assert.equal(products[0].availableForSale, 15);
  });

  test('one file can mix the new brand and a built-in one without crossing them', async () => {
    await createProductModel('Koken').create({ skuCode: 'K-1' });
    const job = await stage([['K-1', '', '3', ''], ['ST-NEW-3', '', '4', '']]);
    await answer(job, { 'ST-NEW-3': 'Stanley Tools' });
    const done = await run(job);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));

    assert.equal((await where('K-1')).balance.brand, 'Koken');
    assert.equal((await where('ST-NEW-3')).balance.brand, 'Stanley Tools');
  });

  test('inventory staff can file into the new brand without it being ticked on their account', async () => {
    const job = await stage([['ST-NEW-4', '', '2', '']], { actor: INVENTORY_MANAGER });
    const res = await answer(job, { 'ST-NEW-4': 'Stanley Tools' }, INVENTORY_MANAGER);
    assert.deepEqual(res.errors, []);
    assert.equal(res.ready, true);
    const done = await run(job, INVENTORY_MANAGER);
    assert.equal(done.status, 'Completed', JSON.stringify(done.fileErrors));
    assert.equal((await where('ST-NEW-4')).balance.brand, 'Stanley Tools');
  });

  test('a brand that does not exist is refused in the prompt', async () => {
    const job = await stage([['ST-NEW-5', '', '2', '']]);
    // Reported per SKU (the screen shows it beside that row), and nothing is stored...
    const res = await answer(job, { 'ST-NEW-5': 'Stanly' });
    assert.match(res.errors.join(' '), /"Stanly" is not a brand\. Expected Koken, BIX, IMADA, Stanley Tools/);
    assert.equal(res.ready, false);
    // ...so the import cannot be confirmed and nothing is filed under a guess.
    await assert.rejects(confirmJob({ jobId: job.jobId, actor: ADMIN, req: null }), /still need a Brand/);
    assert.equal(await Product.countDocuments({ skuCode: 'ST-NEW-5' }), 0);
  });
});
