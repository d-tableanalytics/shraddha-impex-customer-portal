/**
 * The legacy /api routes need a login.
 *
 * routes/api.routes.js is mounted at /api as well as /api/v1. Under /api its
 * product reads and both order routes answered without any login: POST
 * /api/orders deducted stock and GET /api/orders listed every customer's orders.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { buildTestApp, withServer, get, post } from './helpers/http.js';
import { startTestMongo, stopTestMongo, clearCollections } from './helpers/mongo.js';
import User from '../models/User.js';
import apiRoutes from '../routes/api.routes.js';
import { loadRoles } from '../utils/roleResolver.js';

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'legacy-api-test-secret';
  await startTestMongo();
});
after(stopTestMongo);
beforeEach(async () => {
  await clearCollections();
  await loadRoles(); // no rows: every role resolves to its compiled-in baseline
});

let seq = 0;
async function account(role) {
  seq += 1;
  const user = await User.create({
    email: `legacy${seq}@example.com`, password: 'x'.repeat(12), user: `A ${role}`, role, status: 'Active',
  });
  const token = jwt.sign({ id: String(user._id), type: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { user, auth: { headers: { Authorization: `Bearer ${token}` } } };
}

const app = () => buildTestApp({ mount: (a) => a.use('/api', apiRoutes) });

test('every formerly open route now answers 401 without a login', async () => {
  await withServer(app(), async (url) => {
    assert.equal((await get(url, '/api/products/koken')).status, 401);
    assert.equal((await get(url, '/api/products/koken/SKU-1')).status, 401);
    assert.equal((await get(url, '/api/orders')).status, 401);
    assert.equal((await post(url, '/api/orders', { brand: 'Koken', skuCode: 'X', quantity: 1 })).status, 401);
  });
});

test('the all-orders list is for the desk, not for a customer', async () => {
  await withServer(app(), async (url) => {
    const customer = await account('Customer');
    assert.equal((await get(url, '/api/orders', customer.auth)).status, 403);
    const sales = await account('Sales');
    assert.equal((await get(url, '/api/orders', sales.auth)).status, 200);
  });
});

test('placing an order needs create_order', async () => {
  await withServer(app(), async (url) => {
    const warehouse = await account('Warehouse User');
    const res = await post(url, '/api/orders', { brand: 'Koken', skuCode: 'X', quantity: 1 }, warehouse.auth);
    assert.equal(res.status, 403);
  });
});
