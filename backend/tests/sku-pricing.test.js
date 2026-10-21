/**
 * SKU pricing: one SKU from Inventory Master's Update Stock dialog, and many
 * through the SKU Pricing import.
 *
 * The properties that matter: only the named tiers change, stock never moves,
 * no SKU is ever created, bad codes and bad prices are reported per row, and
 * the staged rows (which ARE the price list) are not readable on VIEW_INVENTORY
 * alone.
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

const { Product, ProductKoken, ProductBIX } = await import('../models/Product.js');
const { default: StockMovement } = await import('../models/StockMovement.js');
const { default: AuditLog } = await import('../models/AuditLog.js');
const { default: ImportError } = await import('../models/ImportError.js');
const { parsePricePatch, updateSkuPricing, getSkuPricing } = await import('../modules/inventory/skuPricing.service.js');
const { createImportJob, confirmJob, getJob } = await import('../modules/inventory/import.service.js');
const { preview, errors: errorsHandler } = await import('../modules/inventory/import.controller.js');
const { getPricing, putPricing } = await import('../modules/inventory/skuPricing.controller.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

const ADMIN = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', permissions: ['*'] };
const INVENTORY_MANAGER = {
  _id: new mongoose.Types.ObjectId(), role: 'Inventory Manager', brandAccess: { koken: true, bix: true },
};
const WAREHOUSE = {
  _id: new mongoose.Types.ObjectId(), role: 'Warehouse User', brandAccess: { koken: true, bix: true },
};

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  await ProductKoken.create({
    skuCode: 'K-1', msilCode: 'M-1', availableForSale: 40, totalAvailableQuantity: 40,
    prices: { trader: 100, endUser: 150 },
  });
  await ProductKoken.create({ skuCode: 'K-2', availableForSale: 5, totalAvailableQuantity: 5 });
  await ProductBIX.create({ skuCode: 'B-1', availableForSale: 9, totalAvailableQuantity: 9 });
});

const pricesOf = async (skuCode, brand) =>
  (await Product.findOne({ skuCode, brand }, 'prices availableForSale totalAvailableQuantity').lean());

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, headers: {}, method: 'GET', originalUrl: '/test', ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  if (err) errorHandler(err, full, res, () => {});
  return res;
};

const writeCsv = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-pricing-'));
  const file = path.join(dir, 'prices.csv');
  fs.writeFileSync(file, rows.map((r) => r.join(',')).join('\n'));
  return file;
};

const HEADER = ['SKU Code', 'MSIL Code', 'Brand', 'Venus Automation Price', 'Trader Price', 'End User Price', 'MSIL Price'];

const stage = async (rows, actor = ADMIN) => {
  const filePath = writeCsv([HEADER, ...rows]);
  return createImportJob({
    filePath, fileName: 'prices.csv', fileType: 'csv', fileSize: fs.statSync(filePath).size,
    importType: 'sku-pricing', actor, req: null,
  });
};

const runToEnd = async (jobId) => {
  await confirmJob({ jobId, actor: ADMIN, req: null });
  for (let i = 0; i < 100; i += 1) {
    const job = await getJob(jobId);
    if (!['Processing'].includes(job.status)) return job;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('import did not finish');
};

describe('parsePricePatch', () => {
  test('blank clears, amounts round to the paisa', () => {
    assert.deepEqual(parsePricePatch({ trader: '1,250.555', msil: '' }), { trader: 1250.56, msil: null });
  });
  test('zero, negatives and words are refused', () => {
    for (const bad of [0, -5, 'abc']) {
      assert.throws(() => parsePricePatch({ trader: bad }), /Trader price/);
    }
  });
  test('an unknown tier is refused, not ignored', () => {
    assert.throws(() => parsePricePatch({ dealer: 10 }), /Unknown price type "dealer"/);
  });
});

describe('single SKU update', () => {
  test('changes only the named tier and leaves stock alone', async () => {
    const result = await updateSkuPricing({
      skuCode: 'K-1', brand: 'Koken', prices: { trader: 120.5 }, actor: ADMIN, req: null,
    });
    assert.deepEqual(result.changed, ['trader']);
    const p = await pricesOf('K-1', 'Koken');
    assert.equal(p.prices.trader, 120.5);
    assert.equal(p.prices.endUser, 150);
    assert.equal(p.availableForSale, 40);
    assert.equal(p.totalAvailableQuantity, 40);
    assert.equal(await StockMovement.countDocuments(), 0);
    const audit = await AuditLog.findOne({ action: 'SKU Pricing Updated' }).lean();
    // Which tier changed — never the amounts: the audit log is readable by HR
    // roles without pricing access (release defect DEF-P01).
    assert.deepEqual(audit.meta.tiers, [{ tier: 'trader', removed: false }]);
    assert.ok(!JSON.stringify(audit).includes('120.5') && !JSON.stringify(audit).includes('"from"'));
  });

  test('null removes a price', async () => {
    await updateSkuPricing({ skuCode: 'K-1', brand: 'Koken', prices: { endUser: null }, actor: ADMIN });
    assert.equal((await getSkuPricing({ skuCode: 'K-1', brand: 'Koken' })).prices.endUser, null);
  });

  test('a no-op and an unknown SKU are refused', async () => {
    await assert.rejects(
      updateSkuPricing({ skuCode: 'K-1', brand: 'Koken', prices: { trader: 100 }, actor: ADMIN }),
      /already on file/,
    );
    await assert.rejects(
      updateSkuPricing({ skuCode: 'NOPE', brand: 'Koken', prices: { trader: 1 }, actor: ADMIN }),
      (e) => e.status === 404,
    );
  });

  test('the endpoint is brand-scoped like the stock adjustment', async () => {
    const user = { ...ADMIN, permissions: undefined, role: 'Custom', brandAccess: { koken: true } };
    const res = await call(getPricing, { user, params: { sku: 'B-1' }, query: { brand: 'BIX' } });
    assert.equal(res.statusCode, 404);
    const ok = await call(putPricing, {
      user: ADMIN, method: 'PUT', params: { sku: 'K-2' }, body: { brand: 'Koken', prices: { msil: '99' } },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal((await pricesOf('K-2', 'Koken')).prices.msil, 99);
  });
});

describe('SKU Pricing import', () => {
  test('validates codes and prices, updates matches, reports the rest', async () => {
    const job = await stage([
      ['K-1', '', '', '', '110', '', ''],          // trader changes, endUser left alone
      ['', 'M-1', '', '', '', '', '80'],           // duplicate of K-1 via MSIL
      ['K-2', '', '', '"₹1,000"', '', '', ''],     // currency formatting accepted
      ['B-1', '', 'BIX', '', '', '', '0'],         // zero is not a price
      ['GHOST', '', '', '', '5', '', ''],          // not in the catalogue
      ['K-2', '', '', '', '', '', ''],             // no price at all (and a duplicate)
      ['K-1', 'M-9', '', '', '1', '', ''],         // MSIL contradicts the SKU
    ]);
    assert.equal(job.status, 'Validated');
    assert.equal(job.totalRows, 7);
    assert.equal(job.validRows, 2);
    assert.equal(job.invalidRows, 5);

    const messages = (await ImportError.find({ jobId: job.jobId }).lean()).map((e) => e.message).join('\n');
    assert.match(messages, /Duplicate of row/);
    assert.match(messages, /must be at least ₹0\.01/);
    assert.match(messages, /GHOST/);
    assert.match(messages, /is MSIL M-1 in the catalogue, not M-9/);

    const done = await runToEnd(job.jobId);
    assert.equal(done.status, 'Partial');
    assert.equal(done.successfulRows, 2);
    assert.equal(done.failedRows, 0);

    const k1 = await pricesOf('K-1', 'Koken');
    assert.equal(k1.prices.trader, 110);
    assert.equal(k1.prices.endUser, 150);
    assert.equal(k1.availableForSale, 40);
    assert.equal((await pricesOf('K-2', 'Koken')).prices.venusAutomation, 1000);
    assert.equal((await pricesOf('B-1', 'BIX')).prices.msil, null);

    // Nothing created, nothing posted.
    assert.equal(await Product.countDocuments(), 3);
    assert.equal(await StockMovement.countDocuments(), 0);
  });

  test('a row repeating the figures on file succeeds without writing', async () => {
    const job = await stage([['K-1', '', '', '', '100', '150', '']]);
    const done = await runToEnd(job.jobId);
    assert.equal(done.status, 'Completed');
    assert.equal(done.successfulRows, 1);
    assert.equal(await AuditLog.countDocuments({ action: 'SKU Pricing Imported' }), 0);
  });

  // Warehouse User holds VIEW_INVENTORY and no pricing permission — the role
  // that must never see prices (Inventory Manager may update them since 2026-10-21).
  test('the staged rows are not readable on VIEW_INVENTORY alone', async () => {
    const job = await stage([['K-1', '', '', '', '110', '', '']]);
    const params = { jobId: job.jobId };

    const blocked = await call(preview, { user: WAREHOUSE, params });
    assert.equal(blocked.statusCode, 404);
    assert.equal((await call(errorsHandler, { user: WAREHOUSE, params })).statusCode, 404);
    assert.equal((await call(preview, { user: INVENTORY_MANAGER, params })).statusCode, 200, 'a pricing holder can');

    const allowed = await call(preview, { user: ADMIN, params });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.payload.rows[0].data.trader, 110);
  });

  test('Warehouse cannot upload it; Inventory Manager can', async () => {
    const { listImportTypes } = await import('../modules/inventory/import.controller.js');
    const allowed = async (user) => (await call(listImportTypes, { user })).payload.data
      .find((t) => t.importType === 'sku-pricing').allowed;
    assert.equal(await allowed(WAREHOUSE), false);
    assert.equal(await allowed(INVENTORY_MANAGER), true);
  });
});
