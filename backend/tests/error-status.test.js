/**
 * The global error handler honours `err.status` as well as `err.statusCode`.
 *
 * The inventory services mark their refusals `err.status = 404` (and 400, 403,
 * 409). The handler used to read only `statusCode`, so every one of them —
 * starting with the stock adjustment's "SKU not found" — went out as a 500.
 */

import test, { before, after, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { startTestMongo, stopTestMongo } from './helpers/mongo.js';

mock.module(new URL('../server.js', import.meta.url).href, {
  namedExports: { io: { emit: () => {}, to: () => ({ emit: () => {} }) } },
});

const { errorHandler } = await import('../middlewares/errorHandler.js');
const { getAdjustmentPreview, postAdjustment } = await import('../modules/inventory/adjustment.controller.js');

before(async () => { await startTestMongo(); });
after(async () => { await stopTestMongo(); });

const respond = (err) => {
  const res = { statusCode: null, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const original = console.error;
  console.error = () => {};
  try { errorHandler(err, {}, res, () => {}); } finally { console.error = original; }
  return res;
};

const call = async (handler, req) => {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.payload = b; return res; };
  const full = { body: {}, params: {}, query: {}, headers: {}, app: { get: () => null }, ...req };
  let err = null;
  await handler(full, res, (e) => { err = e; });
  return err ? respond(err) : res;
};

describe('errorHandler status', () => {
  test('err.status is used', () => {
    const res = respond(Object.assign(new Error('nope'), { status: 404 }));
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.message, 'nope');
  });

  test('err.statusCode still wins when both are set', () => {
    assert.equal(respond(Object.assign(new Error('x'), { statusCode: 409, status: 404 })).statusCode, 409);
  });

  test('a status outside 4xx/5xx, or not a number, falls back to 500', () => {
    for (const status of [200, 302, '404', 'Open']) {
      assert.equal(respond(Object.assign(new Error('x'), { status })).statusCode, 500);
    }
    assert.equal(respond(new Error('plain')).statusCode, 500);
  });
});

describe('stock adjustment refusals reach the client with their own status', () => {
  const user = { _id: new mongoose.Types.ObjectId(), role: 'Custom', brandAccess: { koken: true } };

  test('a brand the caller cannot see is a 404, not a 500', async () => {
    const res = await call(getAdjustmentPreview, { user, params: { sku: 'B-1' }, query: { brand: 'BIX' } });
    assert.equal(res.statusCode, 404);
  });

  test('a missing brand is a 400', async () => {
    const res = await call(postAdjustment, { user, params: { sku: 'K-1' }, body: {} });
    assert.equal(res.statusCode, 400);
  });

  test('no brand access at all is a 403', async () => {
    const res = await call(getAdjustmentPreview, {
      user: { ...user, brandAccess: {} }, params: { sku: 'K-1' }, query: { brand: 'Koken' },
    });
    assert.equal(res.statusCode, 403);
  });
});
