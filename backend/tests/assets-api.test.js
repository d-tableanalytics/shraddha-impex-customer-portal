/**
 * Assets — the HTTP layer, over a real MongoDB.
 *
 * Only `protect` is stubbed, exactly as the Employee Master, Leave, Expenses
 * and Exits route tests do it. The permission chain, the validator, the service
 * and the error handler are all the genuine article.
 *
 * The tests that matter most are the ones about the item/assignment invariant:
 * an asset that reads as issued must have somebody holding it, and an asset
 * somebody holds must read as issued. The reference lets those two drift.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

import Employee from '../models/hrms/Employee.js';
import ExitRequest from '../models/hrms/ExitRequest.js';
import { AssetCategory, AssetItem, AssetRequest } from '../models/hrms/AssetModels.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import assetRoutes from '../modules/hrms/assets/asset.routes.js';
import exitRoutes from '../modules/hrms/exits/exit.routes.js';
import { hrmsAuthorizationChain, setEmployeeResolver } from '../middlewares/hrmsAuth.js';
import { hrmsErrorHandler } from '../modules/hrms/hrms.errors.js';
import {
  registerReferenceProvider,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { employeeReferenceProvider } from '../modules/hrms/employees/employee.provider.js';
import { AUDIT_ACTIONS } from '../shared/constants/hrms.js';
import { HRMS_ROLES as R } from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get, post, patch, del } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

const P = '/api/v1/hrms/assets';
const X = '/api/v1/hrms/exits';
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  await startTestMongo();
  await syncIndexes(Employee, AssetCategory, AssetItem, AssetRequest, ExitRequest);
});

after(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  __resetReferenceProviders();
  registerReferenceProvider('employee', employeeReferenceProvider);
  setEmployeeResolver((userId) => employeeReferenceProvider.byUserId(userId));
});

/** Assets alone, or Assets + Exits when a test crosses the boundary. */
function appFor(user, { withExits = false } = {}) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.use('/assets', assetRoutes);
      if (withExits) router.use('/exits', exitRoutes);
      router.use(hrmsErrorHandler);
      app.use('/api/v1/hrms', router);
    },
  });
}

let seq = 0;
async function makePerson(roles, over = {}) {
  seq += 1;
  const userId = oid();
  await User.create({
    _id: userId,
    name: `${over.firstName ?? 'Test'} Person`,
    email: `assets${seq}@example.com`,
    password: 'hashed-not-used',
    role: 'Management',
    roles,
    status: 'Active',
  });
  const employee = await Employee.create({
    employeeCode: `AS-${String(seq).padStart(4, '0')}`,
    userId,
    firstName: over.firstName ?? 'Test',
    lastName: over.lastName ?? `Person${seq}`,
    dateOfJoining: new Date('2020-01-01'),
    status: over.status ?? 'active',
    ...over,
  });
  return { user: { _id: userId, role: 'Management', roles, status: 'Active' }, employee };
}

const envelope = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
};

const errorBody = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  if (code) assert.equal(res.body.code, code);
  return res.body;
};

async function seedOrg() {
  const it = await makePerson([R.IT_ADMIN], { firstName: 'Ivan' });
  const hr = await makePerson([R.HR_ADMIN], { firstName: 'Hana' });
  const staff = await makePerson([R.EMPLOYEE], { firstName: 'Sam' });
  const other = await makePerson([R.EMPLOYEE], { firstName: 'Otto' });
  return { it, hr, staff, other };
}

const validCategory = (over = {}) => ({
  name: 'Laptop',
  code: 'LAPTOP',
  requiresSerialNumber: true,
  defaultLifespanMonths: 36,
  ...over,
});

const validItem = (categoryId, over = {}) => ({
  categoryId: String(categoryId),
  serialNumber: `SN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  brand: 'Dell',
  model: 'XPS 15',
  purchaseDate: '2025-04-01',
  warrantyEnd: '2028-04-01',
  purchasePrice: '125000.00',
  ...over,
});

/** A category plus one available item, as IT. */
async function seedInventory(url, over = {}) {
  const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
  const item = envelope(
    await post(url, `${P}/items`, validItem(category.id, over)),
    201,
  );
  return { category, item };
}

// ===========================================================================
// Categories
// ===========================================================================

test('IT creates a category; an employee can read the catalogue but not write it', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    assert.equal(category.code, 'LAPTOP');
    assert.equal(category.itemCount, 0);
  });

  await withServer(appFor(staff.user), async (url) => {
    // A requester must be able to pick a category.
    const list = envelope(await get(url, `${P}/categories`));
    assert.equal(list.length, 1);
    errorBody(await post(url, `${P}/categories`, validCategory({ code: 'PHONE' })), 403);
  });
});

test('a category code is lower-cased in and stored upper-cased, and is unique', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const created = envelope(
      await post(url, `${P}/categories`, validCategory({ code: 'phone' })),
      201,
    );
    assert.equal(created.code, 'PHONE');
    errorBody(
      await post(url, `${P}/categories`, validCategory({ code: 'PHONE', name: 'Handset' })),
      409,
      'ASSET_CATEGORY_CODE_TAKEN',
    );
  });
});

test('a category with items or requests cannot be deleted', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    const { category } = await seedInventory(url);
    categoryId = category.id;
    errorBody(await del(url, `${P}/categories/${categoryId}`), 409, 'ASSET_CATEGORY_IN_USE');
  });

  // Even with no items, an open request holds it. The reference counts only
  // items, so it would hard-delete here and orphan the request.
  const empty = await AssetCategory.create({ name: 'Monitor', code: 'MONITOR' });
  await withServer(appFor(staff.user), async (url) => {
    envelope(
      await post(url, `${P}/requests`, {
        categoryId: String(empty._id),
        justification: 'Second screen.',
      }),
      201,
    );
  });
  await withServer(appFor(it.user), async (url) => {
    errorBody(await del(url, `${P}/categories/${empty._id}`), 409, 'ASSET_CATEGORY_IN_USE');
  });
});

test('deleting a category is SOFT, and frees the code for reuse', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    envelope(await del(url, `${P}/categories/${category.id}`));

    assert.equal(envelope(await get(url, `${P}/categories`)).length, 0);
    // The row survives; only the code is freed.
    assert.ok(await AssetCategory.findById(category.id).lean());
    envelope(await post(url, `${P}/categories`, validCategory()), 201);
  });
});

// ===========================================================================
// Inventory
// ===========================================================================

test('a serial number is required when the category says so', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const strict = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    errorBody(
      await post(url, `${P}/items`, validItem(strict.id, { serialNumber: null })),
      400,
    );

    const loose = envelope(
      await post(
        url,
        `${P}/categories`,
        validCategory({ code: 'CABLE', name: 'Cable', requiresSerialNumber: false }),
      ),
      201,
    );
    envelope(await post(url, `${P}/items`, validItem(loose.id, { serialNumber: null })), 201);
  });
});

test('a serial number identifies ONE asset', async () => {
  // The reference has neither a constraint nor a check.
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    envelope(await post(url, `${P}/items`, validItem(category.id, { serialNumber: 'DUP-1' })), 201);
    errorBody(
      await post(url, `${P}/items`, validItem(category.id, { serialNumber: 'DUP-1' })),
      409,
      'ASSET_SERIAL_TAKEN',
    );
  });
});

test('money is exact, and a purchase price of ZERO is a price', async () => {
  // `dto.purchasePrice ? ... : null` in the reference turns 0 into null.
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);

    const free = envelope(
      await post(url, `${P}/items`, validItem(category.id, { purchasePrice: '0' })),
      201,
    );
    assert.equal(free.purchasePrice, '0.00', 'zero is a price, not an absent one');
    // Pinned in the database too. The reference loses this to a falsy test on a
    // NUMBER; the string boundary here makes that class of bug unreachable,
    // because "0" is truthy — so this asserts the outcome rather than a guard.
    const storedFree = await AssetItem.findById(free.id).lean();
    assert.notEqual(storedFree.purchasePrice, null, 'zero must not be stored as absent');
    assert.equal(String(storedFree.purchasePrice), '0');

    const priced = envelope(
      await post(url, `${P}/items`, validItem(category.id, { purchasePrice: '125000.5' })),
      201,
    );
    assert.equal(priced.purchasePrice, '125000.50');
    assert.match(priced.purchasePrice, /^\d+\.\d{2}$/);

    const stored = await AssetItem.findById(priced.id).lean();
    assert.equal(stored.purchasePrice.constructor.name, 'Decimal128');
  });
});

test('the inventory is filtered, searched and paged by the SERVER', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    for (const [i, brand] of ['Dell', 'Apple', 'Lenovo'].entries()) {
      envelope(
        await post(url, `${P}/items`, validItem(category.id, { brand, serialNumber: `S-${i}` })),
        201,
      );
    }

    const all = envelope(await get(url, `${P}/items`));
    assert.equal(all.total, 3);
    assert.equal(all.page, 1);

    assert.equal(envelope(await get(url, `${P}/items?search=Apple`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/items?search=S-2`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/items?status=available`)).total, 3);
    assert.equal(envelope(await get(url, `${P}/items?status=lost`)).total, 0);

    const paged = envelope(await get(url, `${P}/items?pageSize=2`));
    assert.equal(paged.data.length, 2);
    assert.equal(paged.total, 3);
  });
});

test('a search term with regex metacharacters is treated as text', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    envelope(await post(url, `${P}/items`, validItem(category.id, { brand: 'A.C' })), 201);
    envelope(await post(url, `${P}/items`, validItem(category.id, { brand: 'ABC' })), 201);

    // `.` must not act as a wildcard, and an unbalanced group must not throw.
    assert.equal(envelope(await get(url, `${P}/items?search=A.C`)).total, 1);
    assert.equal(envelope(await get(url, `${P}/items?search=%28%28%28`)).total, 0);
  });
});

test('an ordinary employee cannot browse the inventory', async () => {
  const { it, staff } = await seedOrg();
  await withServer(appFor(it.user), async (url) => {
    await seedInventory(url);
  });

  await withServer(appFor(staff.user), async (url) => {
    errorBody(await get(url, `${P}/items`), 403);
  });
});

// ===========================================================================
// Assignment
// ===========================================================================

test('assigning flips the status and records who holds it', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    assert.equal(item.status, 'available');

    const assigned = envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
        conditionOnAssign: 'Minor scratch on the lid.',
      }),
    );

    assert.equal(assigned.status, 'assigned');
    assert.equal(assigned.currentAssignment.employeeId, String(staff.employee._id));
    assert.match(assigned.currentAssignment.employeeName, /Sam/);
    assert.equal(assigned.currentAssignment.conditionOnAssign, 'Minor scratch on the lid.');

    // The derived pointer and the status agree, in the database.
    const stored = await AssetItem.findById(item.id).lean();
    assert.equal(String(stored.assignedToEmployeeId), String(staff.employee._id));
  });
});

test('an asset already out cannot be assigned again', async () => {
  const { it, staff, other } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
    errorBody(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(other.employee._id),
      }),
      409,
      'ASSET_NOT_AVAILABLE',
    );
  });
});

test('an asset is not issued to somebody who has left', async () => {
  // The reference checks only that the employee row exists.
  const { it } = await seedOrg();
  const gone = await makePerson([R.EMPLOYEE], { firstName: 'Gone', status: 'exited' });

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    errorBody(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(gone.employee._id),
      }),
      409,
      'EMPLOYEE_NOT_ACTIVE',
    );
  });
});

test('an asset is not issued to a soft-deleted employee', async () => {
  const { it, staff } = await seedOrg();
  await Employee.updateOne({ _id: staff.employee._id }, { $set: { deletedAt: new Date() } });

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    errorBody(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
      400,
    );
  });
});

test('returning records a condition and frees the asset', async () => {
  // The reference's own return control posts `{}`, so its "Condition on return"
  // column can only ever render a dash.
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );

    const returned = envelope(
      await post(url, `${P}/items/${item.id}/return`, {
        conditionOnReturn: 'Keyboard sticky, otherwise fine.',
      }),
    );
    assert.equal(returned.status, 'available');
    assert.equal(returned.currentAssignment, null);

    const detail = envelope(await get(url, `${P}/items/${item.id}`));
    assert.equal(detail.assignments.length, 1);
    assert.equal(detail.assignments[0].conditionOnReturn, 'Keyboard sticky, otherwise fine.');
    assert.ok(detail.assignments[0].returnedAt);
  });
});

test('returning an asset nobody holds is refused', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    errorBody(await post(url, `${P}/items/${item.id}/return`, {}), 409, 'ASSET_NOT_ASSIGNED');
  });
});

test('an asset can be re-issued after it comes back', async () => {
  const { it, staff, other } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
    envelope(await post(url, `${P}/items/${item.id}/return`, {}));
    const again = envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(other.employee._id),
      }),
    );
    assert.match(again.currentAssignment.employeeName, /Otto/);
    assert.equal(again.assignmentCount, 2, 'both cycles are in the history');
  });
});

// ===========================================================================
// Status transitions
// ===========================================================================

test('`assigned` CANNOT be set directly', async () => {
  // The reference accepts it, leaving an item that reads as issued to nobody
  // and which assign() then refuses because it is no longer available.
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    errorBody(await post(url, `${P}/items/${item.id}/status`, { status: 'assigned' }), 400);

    const still = envelope(await get(url, `${P}/items/${item.id}`));
    assert.equal(still.status, 'available');
  });
});

test('retiring an issued asset closes the assignment, and the two never disagree', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );

    const retired = envelope(
      await post(url, `${P}/items/${item.id}/status`, {
        status: 'retired',
        note: 'Written off after water damage.',
      }),
    );
    assert.equal(retired.status, 'retired');
    assert.equal(retired.currentAssignment, null);

    const stored = await AssetItem.findById(item.id).lean();
    assert.equal(stored.assignedToEmployeeId, null);
    assert.equal(stored.assignments[0].closedByStatus, 'retired');
    assert.ok(stored.assignments[0].returnedAt);
  });
});

test('a retired or lost asset is out of circulation for good', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(await post(url, `${P}/items/${item.id}/status`, { status: 'lost' }));

    errorBody(
      await post(url, `${P}/items/${item.id}/status`, { status: 'available' }),
      409,
      'ASSET_TERMINAL',
    );
    errorBody(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
      409,
      'ASSET_NOT_AVAILABLE',
    );
  });
});

test('setting the status it already has is refused', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    errorBody(
      await post(url, `${P}/items/${item.id}/status`, { status: 'available' }),
      409,
      'ASSET_STATUS_UNCHANGED',
    );
  });
});

// ===========================================================================
// My assets
// ===========================================================================

test('an employee sees WHICH asset they hold, not just when', async () => {
  // The reference's assignment DTO omits the item entirely, so its My Assets
  // table shows dates and conditions and never says what the asset is.
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
  });

  await withServer(appFor(staff.user), async (url) => {
    const mine = envelope(await get(url, `${P}/assignments/me`));
    assert.equal(mine.data.length, 1);
    assert.equal(mine.outstanding, 1);

    const row = mine.data[0];
    assert.equal(row.categoryName, 'Laptop');
    assert.ok(row.serialNumber, 'the serial number identifies the asset');
    assert.equal(row.brand, 'Dell');
    assert.equal(row.model, 'XPS 15');
    assert.equal(row.returnedAt, null);
  });
});

test('a returned asset stays in the employee’s history', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
    envelope(await post(url, `${P}/items/${item.id}/return`, {}));
  });

  await withServer(appFor(staff.user), async (url) => {
    const mine = envelope(await get(url, `${P}/assignments/me`));
    assert.equal(mine.data.length, 1);
    assert.equal(mine.outstanding, 0);
    assert.ok(mine.data[0].returnedAt);
  });
});

test('one employee cannot read another employee’s assets', async () => {
  const { it, staff, other } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
  });

  await withServer(appFor(other.user), async (url) => {
    errorBody(
      await get(url, `${P}/assignments/employee/${staff.employee._id}`),
      403,
    );
    // Their own is fine, and empty.
    assert.equal(
      envelope(await get(url, `${P}/assignments/employee/${other.employee._id}`)).data.length,
      0,
    );
  });
});

// ===========================================================================
// Requests
// ===========================================================================

test('an employee raises a request and an administrator sees it in the queue', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    const request = envelope(
      await post(url, `${P}/requests`, {
        categoryId,
        justification: 'My current machine will not run the build.',
      }),
      201,
    );
    assert.equal(request.status, 'submitted');
    assert.equal(request.employeeId, String(staff.employee._id));
    assert.equal(request.categoryName, 'Laptop');
  });

  await withServer(appFor(it.user), async (url) => {
    const queue = envelope(await get(url, `${P}/requests`));
    assert.equal(queue.total, 1);
    assert.match(queue.data[0].employeeName, /Sam/);
  });
});

test('an employee sees only their own requests', async () => {
  const { it, staff, other } = await seedOrg();
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });
  for (const person of [staff, other]) {
    await withServer(appFor(person.user), async (url) => {
      envelope(await post(url, `${P}/requests`, { categoryId, justification: 'Need one.' }), 201);
    });
  }

  await withServer(appFor(staff.user), async (url) => {
    const mine = envelope(await get(url, `${P}/requests`));
    assert.equal(mine.total, 1);
    assert.equal(mine.data[0].employeeId, String(staff.employee._id));
  });
  await withServer(appFor(it.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/requests`)).total, 2);
  });
});

test('a second open request for the same category is refused', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });

  await withServer(appFor(staff.user), async (url) => {
    envelope(await post(url, `${P}/requests`, { categoryId, justification: 'One.' }), 201);
    errorBody(
      await post(url, `${P}/requests`, { categoryId, justification: 'Again.' }),
      409,
      'ASSET_REQUEST_OPEN',
    );
  });
});

test('an employee cannot decide or fulfil a request', async () => {
  const { it, staff } = await seedOrg();
  let requestId;
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    requestId = envelope(
      await post(url, `${P}/requests`, { categoryId, justification: 'Need one.' }),
      201,
    ).id;
    errorBody(await post(url, `${P}/requests/${requestId}/decide`, { decision: 'approve' }), 403);
    errorBody(
      await post(url, `${P}/requests/${requestId}/fulfill`, { assetItemId: String(oid()) }),
      403,
    );
  });
});

test('NOBODY decides the request they raised', async () => {
  // An IT admin is also an employee and can raise one.
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const category = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    const request = envelope(
      await post(url, `${P}/requests`, {
        categoryId: category.id,
        justification: 'Mine.',
      }),
      201,
    );
    const body = errorBody(
      await post(url, `${P}/requests/${request.id}/decide`, { decision: 'approve' }),
      403,
    );
    assert.match(body.message, /your own asset request/i);
  });
});

test('the request lifecycle runs submitted -> approved -> fulfilled, and issues the asset', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;
  let itemId;
  let requestId;

  await withServer(appFor(it.user), async (url) => {
    const seeded = await seedInventory(url);
    categoryId = seeded.category.id;
    itemId = seeded.item.id;
  });
  await withServer(appFor(staff.user), async (url) => {
    requestId = envelope(
      await post(url, `${P}/requests`, { categoryId, justification: 'Build machine.' }),
      201,
    ).id;
  });

  await withServer(appFor(it.user), async (url) => {
    // Cannot fulfil before approval.
    errorBody(
      await post(url, `${P}/requests/${requestId}/fulfill`, { assetItemId: itemId }),
      409,
      'ASSET_REQUEST_BAD_STATE',
    );

    const approved = envelope(
      await post(url, `${P}/requests/${requestId}/decide`, { decision: 'approve' }),
    );
    assert.equal(approved.status, 'approved');
    assert.match(approved.decidedByName, /Ivan/);

    const fulfilled = envelope(
      await post(url, `${P}/requests/${requestId}/fulfill`, { assetItemId: itemId }),
    );
    assert.equal(fulfilled.status, 'fulfilled');
    assert.ok(fulfilled.fulfilledSerialNumber);

    // Fulfilling really issued it.
    const item = envelope(await get(url, `${P}/items/${itemId}`));
    assert.equal(item.status, 'assigned');
    assert.equal(item.currentAssignment.employeeId, String(staff.employee._id));
  });

  await withServer(appFor(staff.user), async (url) => {
    assert.equal(envelope(await get(url, `${P}/assignments/me`)).outstanding, 1);
  });
});

test('fulfilling with an item from the wrong category is refused', async () => {
  const { it, staff } = await seedOrg();
  let laptopCategoryId;
  let phoneItemId;
  let requestId;

  await withServer(appFor(it.user), async (url) => {
    const laptop = envelope(await post(url, `${P}/categories`, validCategory()), 201);
    laptopCategoryId = laptop.id;
    const phone = envelope(
      await post(url, `${P}/categories`, validCategory({ code: 'PHONE', name: 'Phone' })),
      201,
    );
    phoneItemId = envelope(await post(url, `${P}/items`, validItem(phone.id)), 201).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    requestId = envelope(
      await post(url, `${P}/requests`, {
        categoryId: laptopCategoryId,
        justification: 'Laptop please.',
      }),
      201,
    ).id;
  });
  await withServer(appFor(it.user), async (url) => {
    envelope(await post(url, `${P}/requests/${requestId}/decide`, { decision: 'approve' }));
    errorBody(
      await post(url, `${P}/requests/${requestId}/fulfill`, { assetItemId: phoneItemId }),
      400,
    );
  });
});

test('a rejection carries its reason, and cannot then be fulfilled', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;
  let itemId;
  let requestId;

  await withServer(appFor(it.user), async (url) => {
    const seeded = await seedInventory(url);
    categoryId = seeded.category.id;
    itemId = seeded.item.id;
  });
  await withServer(appFor(staff.user), async (url) => {
    requestId = envelope(
      await post(url, `${P}/requests`, { categoryId, justification: 'Want one.' }),
      201,
    ).id;
  });

  await withServer(appFor(it.user), async (url) => {
    const rejected = envelope(
      await post(url, `${P}/requests/${requestId}/decide`, {
        decision: 'reject',
        reason: 'Your current machine is six months old.',
      }),
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'Your current machine is six months old.');

    errorBody(
      await post(url, `${P}/requests/${requestId}/decide`, { decision: 'approve' }),
      409,
      'ASSET_REQUEST_BAD_STATE',
    );
    errorBody(
      await post(url, `${P}/requests/${requestId}/fulfill`, { assetItemId: itemId }),
      409,
      'ASSET_REQUEST_BAD_STATE',
    );
  });
});

test('the requester cancels their own request; a stranger cannot', async () => {
  const { it, staff, other } = await seedOrg();
  let categoryId;
  let requestId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    requestId = envelope(
      await post(url, `${P}/requests`, { categoryId, justification: 'Need one.' }),
      201,
    ).id;
  });

  await withServer(appFor(other.user), async (url) => {
    errorBody(await post(url, `${P}/requests/${requestId}/cancel`, {}), 403);
  });
  await withServer(appFor(staff.user), async (url) => {
    const cancelled = envelope(await post(url, `${P}/requests/${requestId}/cancel`, {}));
    assert.equal(cancelled.status, 'cancelled');
    errorBody(
      await post(url, `${P}/requests/${requestId}/cancel`, {}),
      409,
      'ASSET_REQUEST_BAD_STATE',
    );
  });
});

test('cancelling frees the category for a fresh request', async () => {
  const { it, staff } = await seedOrg();
  let categoryId;

  await withServer(appFor(it.user), async (url) => {
    categoryId = envelope(await post(url, `${P}/categories`, validCategory()), 201).id;
  });
  await withServer(appFor(staff.user), async (url) => {
    const first = envelope(
      await post(url, `${P}/requests`, { categoryId, justification: 'One.' }),
      201,
    );
    envelope(await post(url, `${P}/requests/${first.id}/cancel`, {}));
    envelope(await post(url, `${P}/requests`, { categoryId, justification: 'Again.' }), 201);
  });
});

// ===========================================================================
// Exit integration — Assets must not change how Exits behaves
// ===========================================================================

test('EXIT INTEGRATION: the IT admin can see a leaver’s outstanding kit', async () => {
  // This is the whole of the reference's integration: its `it` clearance goes
  // to the IT admin with the comment "(asset return)", and the IT admin holds
  // assets:view:org. No exit code reads assignments, and none is added here.
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );

    const held = envelope(await get(url, `${P}/assignments/employee/${staff.employee._id}`));
    assert.equal(held.outstanding, 1, 'the IT admin can check before signing off');
    assert.ok(held.data[0].serialNumber);
  });
});

test('EXIT INTEGRATION: Assets does not alter the exit clearance flow', async () => {
  const hr = await makePerson([R.HR_ADMIN], { firstName: 'Hilda' });
  const itAdmin = await makePerson([R.IT_ADMIN], { firstName: 'Iris' });
  await makePerson([R.PAYROLL_ADMIN], { firstName: 'Fred' });
  const manager = await makePerson([R.MANAGER], { firstName: 'Mo' });
  const leaver = await makePerson([R.EMPLOYEE], {
    firstName: 'Leo',
    reportingManagerId: manager.employee._id,
    managerChain: [manager.employee._id],
  });

  await withServer(appFor(hr.user, { withExits: true }), async (url) => {
    const created = envelope(
      await post(url, X, {
        employeeId: String(leaver.employee._id),
        reason: 'Relocating.',
        reasonCategory: 'resignation',
        requestedLastDay: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      }),
      201,
    );
    envelope(await post(url, `${X}/${created.id}/manager-approve`, {}));
    envelope(await post(url, `${X}/${created.id}/hr-approve`, {}));
    const opened = envelope(await post(url, `${X}/${created.id}/open-clearances`, {}));

    // Unchanged: five areas, and `it` still belongs to the IT admin.
    assert.deepEqual(
      opened.clearances.map((c) => c.area).sort(),
      ['admin', 'finance', 'hr', 'it', 'manager'],
    );
    const itArea = opened.clearances.find((c) => c.area === 'it');
    assert.equal(itArea.assigneeEmployeeId, String(itAdmin.employee._id));

    // And the IT admin still signs it off exactly as before.
    await withServer(appFor(itAdmin.user, { withExits: true }), async (itUrl) => {
      const after = envelope(
        await patch(itUrl, `${X}/${created.id}/clearances/${itArea.id}`, {
          status: 'completed',
          notes: 'Laptop returned.',
        }),
      );
      assert.equal(after.clearances.find((c) => c.area === 'it').status, 'completed');
    });
  });
});

// ===========================================================================
// Audit, envelope, access
// ===========================================================================

test('every asset action is audited, and a refused one is not', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { item } = await seedInventory(url);
    envelope(
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    );
    envelope(await post(url, `${P}/items/${item.id}/return`, {}));

    const actions = (await AuditLog.find({}).lean()).map((r) => r.action);
    for (const expected of [
      AUDIT_ACTIONS.ASSET_CATEGORY_CREATED,
      AUDIT_ACTIONS.ASSET_ITEM_CREATED,
      AUDIT_ACTIONS.ASSET_ASSIGNED,
      AUDIT_ACTIONS.ASSET_RETURNED,
    ]) {
      assert.ok(actions.includes(expected), `${expected} should be audited`);
    }
  });

  await AuditLog.deleteMany({});
  await withServer(appFor(staff.user), async (url) => {
    errorBody(await post(url, `${P}/categories`, validCategory({ code: 'X' })), 403);
    assert.equal(await AuditLog.countDocuments({}), 0);
  });
});

test('every asset response uses the standard envelope', async () => {
  const { it, staff } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    const { category, item } = await seedInventory(url);

    for (const res of [
      await get(url, `${P}/categories`),
      await get(url, `${P}/items`),
      await get(url, `${P}/items/${item.id}`),
      await get(url, `${P}/requests`),
      await get(url, `${P}/assignments/me`),
      await get(url, `${P}/assignments/employee/${staff.employee._id}`),
      await patch(url, `${P}/categories/${category.id}`, { name: 'Laptops' }),
      await post(url, `${P}/items/assign`, {
        assetItemId: item.id,
        employeeId: String(staff.employee._id),
      }),
    ]) {
      assert.equal(res.body.success, true, JSON.stringify(res.body));
      assert.ok('data' in res.body, 'the payload must sit under `data`');
    }
  });
});

test('the inventory and request lists return a page object under `data`', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    await seedInventory(url);
    for (const path of [`${P}/items`, `${P}/requests`]) {
      const page = envelope(await get(url, path));
      assert.ok(Array.isArray(page.data));
      assert.equal(typeof page.total, 'number');
      assert.equal(page.page, 1);
      assert.equal(typeof page.pageSize, 'number');
    }
  });
});

test('AD-4: a Customer reaches no asset endpoint', async () => {
  const customer = { _id: oid(), role: 'Customer', roles: [], status: 'Active' };

  await withServer(appFor(customer), async (url) => {
    for (const res of [
      await get(url, `${P}/categories`),
      await get(url, `${P}/items`),
      await get(url, `${P}/requests`),
      await get(url, `${P}/assignments/me`),
      await post(url, `${P}/requests`, { categoryId: String(oid()), justification: 'x' }),
    ]) {
      assert.ok(res.status === 403 || res.status === 401, `got ${res.status}`);
    }
  });
});

test('an unknown id is a 404, and a malformed one is not a 500', async () => {
  const { it } = await seedOrg();

  await withServer(appFor(it.user), async (url) => {
    errorBody(await get(url, `${P}/items/${oid()}`), 404);
    errorBody(await get(url, `${P}/items/not-an-id`), 404);
    errorBody(await post(url, `${P}/items/not-an-id/status`, { status: 'lost' }), 404);
  });
});
