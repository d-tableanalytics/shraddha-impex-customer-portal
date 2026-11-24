/**
 * Editing a SKU's MSIL code through Inventory Master.
 *
 * The endpoint accepted `msilCode` long before the screen offered the field, so
 * none of these rules had ever been exercised by a test. Putting the field in
 * front of users makes them load-bearing, and each one fails in a way that is
 * invisible from the screen that caused it:
 *
 *   - a DUPLICATE code makes the Fresh Inventory import ambiguous: it finds a
 *     product BY its MSIL code, and two matches import nothing;
 *   - an UNREGISTERED code makes the SKU unbookable by the very customers the
 *     code exists for - booking checks a separate allowlist, not the product;
 *   - a code that was deliberately DEACTIVATED must not be reopened by someone
 *     retyping it on a product form.
 *
 * Driven through the real app over HTTP with the real permission layer.
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
const { default: MsilCode } = await import('../models/MsilCode.js');
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

beforeEach(async () => {
  await clearCollections();
  await seedBrands();
  await Location.create({ code: 'MAIN', name: 'Main', isDefault: true, active: true });
  U = {
    admin: await mkUser('Admin'),
    im: await mkUser('Inventory Manager'),
    sales: await mkUser('Sales'),
  };
});

const http = async (method, url, who, body) => {
  const headers = who ? { 'x-test-user': String(who._id) } : {};
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${server.url}${url}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const PATCH = (url, who, body) => http('PATCH', url, who, body);

const product = (sku, over = {}, brand = 'Koken') => createProductModel(brand).create({
  skuCode: sku, description: `${sku} description`,
  availableForSale: 0, totalAvailableQuantity: 0, bookedQuantity: 0,
  ...over,
});

const planningUrl = (sku) => `/api/v1/inventory/items/${encodeURIComponent(sku)}/planning`;
const find = (sku, brand = 'Koken') => createProductModel(brand).findOne({ skuCode: sku }).lean();

describe('editing the MSIL code', () => {
  test('a code can be set on a SKU that had none', async () => {
    await product('K-1');
    const res = await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: 'MA0NEW00001' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await find('K-1')).msilCode, 'MA0NEW00001');
  });

  test('a new code is added to the allowlist booking checks, Active', async () => {
    // Without this the SKU is left unbookable and fails with "MSIL Code ... is
    // inactive or does not exist" the first time an MSIL customer orders it.
    await product('K-1');
    await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: 'MA0NEW00001' });

    const row = await MsilCode.findOne({ code: 'MA0NEW00001' }).lean();
    assert.ok(row, 'the code reached the allowlist');
    assert.equal(row.status, 'Active');
  });

  test('a code deliberately set Inactive is NOT reopened by retyping it', async () => {
    // Deactivating is how the business withdraws a code. An ordinary product
    // edit must not reopen a gate somebody deliberately shut.
    await MsilCode.create({ code: 'MA0OLD00001', status: 'Inactive' });
    await product('K-1');

    await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: 'MA0OLD00001' });

    assert.equal((await MsilCode.findOne({ code: 'MA0OLD00001' }).lean()).status, 'Inactive');
  });

  test('a code already on another SKU is refused, naming that SKU', async () => {
    await product('K-1', { msilCode: 'MA0LW004000' });
    await product('K-2');

    const res = await PATCH(planningUrl('K-2'), U.im, { brand: 'Koken', msilCode: 'MA0LW004000' });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /already belongs to K-1/);
    assert.equal((await find('K-2')).msilCode, null, 'nothing was written');
  });

  test('the clash check ignores case, so a lookalike cannot slip through', async () => {
    // The Fresh Inventory import matches case-insensitively; a check that did
    // not would let 'ma0lw004000' and 'MA0LW004000' both exist and import none.
    await product('K-1', { msilCode: 'MA0LW004000' });
    await product('K-2');

    const res = await PATCH(planningUrl('K-2'), U.im, { brand: 'Koken', msilCode: 'ma0lw004000' });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /already belongs to K-1/);
  });

  test('re-sending a SKU its OWN code is not a clash', async () => {
    // The form posts every field on every save, so an unchanged code arrives on
    // each one. Treating that as a duplicate would make the panel unsaveable.
    await product('K-1', { msilCode: 'MA0LW004000' });

    const res = await PATCH(planningUrl('K-1'), U.im, {
      brand: 'Koken', msilCode: 'MA0LW004000', vendorName: 'Ko-ken Japan',
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await find('K-1')).vendorName, 'Ko-ken Japan');
  });

  test('an emptied code clears to null rather than an empty string', async () => {
    await product('K-1', { msilCode: 'MA0LW004000' });

    const res = await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: '' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await find('K-1')).msilCode, null);
  });

  test('a code is trimmed before it is stored', async () => {
    await product('K-1');
    await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: '  MA0NEW00001  ' });

    assert.equal((await find('K-1')).msilCode, 'MA0NEW00001');
  });

  test('clearing a code does not deactivate it for the SKUs that still use it', async () => {
    // Registration only ever ADDS. Removing a code from one product says
    // nothing about whether the business still accepts orders against it.
    await MsilCode.create({ code: 'MA0LW004000', status: 'Active' });
    await product('K-1', { msilCode: 'MA0LW004000' });

    await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: '' });

    assert.equal((await MsilCode.findOne({ code: 'MA0LW004000' }).lean()).status, 'Active');
  });

  test('the edit is recorded in the audit trail with before and after', async () => {
    const { default: AuditLog } = await import('../models/AuditLog.js');
    await product('K-1', { msilCode: 'MA0OLD00001' });

    await PATCH(planningUrl('K-1'), U.im, { brand: 'Koken', msilCode: 'MA0NEW00001' });

    const entry = await AuditLog.findOne({ action: 'Inventory Planning Updated' }).lean();
    assert.ok(entry, 'an entry was written');
    assert.equal(entry.meta.before.msilCode, 'MA0OLD00001');
    assert.equal(entry.meta.after.msilCode, 'MA0NEW00001');
  });

  test('a role without Manage Inventory Master cannot change it', async () => {
    await product('K-1', { msilCode: 'MA0LW004000' });

    const res = await PATCH(planningUrl('K-1'), U.sales, { brand: 'Koken', msilCode: 'MA0NEW00001' });

    assert.equal(res.status, 403);
    assert.equal((await find('K-1')).msilCode, 'MA0LW004000', 'nothing was written');
  });
});
