/**
 * Roles & Permissions in the Customer Portal, over HTTP.
 *
 * The roles collection is shared with the Employee Portal, and its save
 * endpoints used to REPLACE the stored grants. These pin the rules that make a
 * second editor safe:
 *
 *   - the roles API answers here (it used to 404), behind manage_roles and a
 *     key per write;
 *   - the catalogue offers only this portal's modules;
 *   - a save changes only this portal's cells and keeps every Employee Portal
 *     cell (o2d, work_queue, hrms) exactly as stored, whatever the request says;
 *   - user administration writes are checked against their own cell, not the
 *     screen's view key.
 */

import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { buildTestApp, withServer, get, post, patch, put } from './helpers/http.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import roleRoutes from '../modules/roles/role.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import { loadRoles, resolveRolePermissions } from '../utils/roleResolver.js';
import { mergeServedGrants, mergeServedPermissions, servedCellKeys } from '../utils/portalGrants.js';
import { PORTALS } from '../config/moduleRegistry.js';

const EMPLOYEE_CELLS = [
  { module: 'o2d', submodule: 'orders', actions: ['view', 'create', 'edit'] },
  { module: 'work_queue', submodule: 'tasks', actions: ['view', 'create'] },
];
const SALES_CUSTOMER_CELLS = [
  { module: 'sales', submodule: 'bookings', actions: ['view', 'edit', 'approve'] },
  { module: 'sales', submodule: 'pricing', actions: ['view'] },
];

before(async () => {
  delete process.env.PORTAL; // this repository's default: the customer portal
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'roles-customer-test-secret';
  await startTestMongo();
  await syncIndexes(User, Role);
});
after(stopTestMongo);

let seq = 0;
async function account(role) {
  seq += 1;
  const user = await User.create({
    email: `roles${seq}@example.com`, password: 'x'.repeat(12), user: `A ${role}`, role, status: 'Active',
  });
  const token = jwt.sign({ id: String(user._id), type: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { user, auth: { headers: { Authorization: `Bearer ${token}` } } };
}

let salesRole;
beforeEach(async () => {
  await clearCollections();
  await Role.create({ name: 'Super Admin', isSuperAdmin: true, isSystem: true, grants: [], permissions: [] });
  salesRole = await Role.create({
    // As the live row: Customer Management is the flat key, not the cell.
    name: 'Sales', isSystem: true, permissions: ['legacy_employee_only_key', 'manage_customer_users'],
    grants: [...SALES_CUSTOMER_CELLS, ...EMPLOYEE_CELLS],
  });
  await loadRoles();
});

const app = () => buildTestApp({
  mount: (a) => { a.use('/api/v1/roles', roleRoutes); a.use('/api/v1/users', userRoutes); },
});

describe('the roles API in this portal', () => {
  test('answers a Super Admin (it used to 404 here)', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const res = await get(url, '/api/v1/roles', admin.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.data.some((r) => r.name === 'Sales'));
    });
  });

  test('refuses Sales with 403 — manage_roles is not reachable from this domain', async () => {
    await withServer(app(), async (url) => {
      const sales = await account('Sales');
      assert.equal((await get(url, '/api/v1/roles', sales.auth)).status, 403);
    });
  });

  test('the catalogue offers only this portal\'s modules', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const res = await get(url, '/api/v1/roles/registry', admin.auth);
      const keys = res.body.data.modules.map((m) => m.key);
      for (const key of ['customer_portal', 'sales', 'inventory', 'administration']) assert.ok(keys.includes(key), key);
      for (const key of ['hrms', 'o2d', 'work_queue']) assert.ok(!keys.includes(key), key);
      const admin_ = res.body.data.modules.find((m) => m.key === 'administration');
      assert.ok(!admin_.submodules.some((s) => s.key === 'roles'), 'the role matrix itself is the Employee Portal\'s');
    });
  });
});

describe('saving a role from this portal', () => {
  test('keeps every Employee Portal cell, whatever the request carries', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      // What a screen showing only this portal's modules sends: its own cells,
      // one of them narrowed, plus a forged attempt to widen an o2d cell.
      const res = await patch(url, `/api/v1/roles/${salesRole._id}`, {
        grants: [
          { module: 'sales', submodule: 'bookings', actions: ['view'] },
          { module: 'o2d', submodule: 'orders', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
        ],
      }, admin.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const stored = (await Role.findById(salesRole._id).lean()).grants
        .map(({ module, submodule, actions }) => ({ module, submodule, actions }));
      const cell = (m, s) => stored.find((g) => g.module === m && g.submodule === s);

      assert.deepEqual(cell('sales', 'bookings').actions, ['view'], 'this portal\'s cell changed');
      assert.equal(cell('sales', 'pricing'), undefined, 'an unsent cell of this portal is removed');
      assert.deepEqual(cell('o2d', 'orders').actions, ['view', 'create', 'edit'], 'o2d kept exactly, forgery ignored');
      assert.deepEqual(cell('work_queue', 'tasks').actions, ['view', 'create'], 'work queue kept');
    });
  });

  test('the legacy flat list keeps keys this portal does not serve', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const res = await put(url, `/api/v1/roles/${salesRole._id}/permissions`, { permissions: ['view_pricing'] }, admin.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { permissions } = await Role.findById(salesRole._id).lean();
      // This portal's flat keys are replaced by the request (manage_customer_users
      // was not in it); the key this portal does not serve is kept.
      assert.deepEqual([...permissions].sort(), ['legacy_employee_only_key', 'view_pricing']);
    });
  });

  test('a new role created here holds only this portal\'s cells', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const res = await post(url, '/api/v1/roles', {
        name: 'Counter Staff',
        grants: [{ module: 'sales', submodule: 'bookings', actions: ['view'] }, EMPLOYEE_CELLS[0]],
      }, admin.auth);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const { grants } = await Role.findOne({ name: 'Counter Staff' }).lean();
      assert.deepEqual(grants.map((g) => g.module), ['sales']);
    });
  });
});

describe('cells that compile to more than their label', () => {
  test('ticking Customer Management stores manage_customer_users, never manage_users', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const res = await post(url, '/api/v1/roles', {
        name: 'Onboarding Desk',
        grants: [{ module: 'administration', submodule: 'customers', actions: ['view', 'create', 'edit'] }],
      }, admin.auth);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const role = await Role.findOne({ name: 'Onboarding Desk' }).lean();
      assert.deepEqual(role.permissions, ['manage_customer_users']);
      assert.equal(role.grants.length, 0, 'the widening cell is not stored');
      const resolved = resolveRolePermissions('Onboarding Desk');
      assert.ok(resolved.includes('manage_customer_users'));
      assert.ok(!resolved.includes('manage_users'), 'no full user administration');
    });
  });

  test('saving Sales without the Customer Management tick removes it; with it, keeps it', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const without = await patch(url, `/api/v1/roles/${salesRole._id}`, { grants: SALES_CUSTOMER_CELLS }, admin.auth);
      assert.equal(without.status, 200);
      assert.ok(!(await Role.findById(salesRole._id).lean()).permissions.includes('manage_customer_users'));

      await patch(url, `/api/v1/roles/${salesRole._id}`, {
        grants: [...SALES_CUSTOMER_CELLS, { module: 'administration', submodule: 'customers', actions: ['view'] }],
      }, admin.auth);
      const { permissions } = await Role.findById(salesRole._id).lean();
      assert.ok(permissions.includes('manage_customer_users'));
      assert.ok(permissions.includes('legacy_employee_only_key'), 'other flat keys untouched');
    });
  });

  test("New Booking's View is derived: a request can neither add nor remove it", async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      await post(url, '/api/v1/roles', {
        name: 'Counter', grants: [{ module: 'customer_portal', submodule: 'create_booking', actions: ['view', 'create'] }],
      }, admin.auth);
      const role = await Role.findOne({ name: 'Counter' }).lean();
      assert.deepEqual(role.grants[0].actions, ['create'], 'view not stored');
      assert.ok(!resolveRolePermissions('Counter').includes('view_all_bookings'), 'no access to every booking');
    });
  });

  test('extra access refuses Customer Management outright', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const target = await account('Sales');
      const res = await put(url, `/api/v1/users/${target.user._id}/access`, {
        extraGrants: [{ module: 'administration', submodule: 'customers', actions: ['view'] }],
      }, admin.auth);
      assert.equal(res.status, 400);
      assert.match(res.body.message, /full user administration/);
    });
  });

  test('the registry tells the screen which cells are narrowed and derived', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const { rules } = (await get(url, '/api/v1/roles/registry', admin.auth)).body.data;
      assert.equal(rules.narrowed['administration.customers'].key, 'manage_customer_users');
      assert.deepEqual(rules.derived['customer_portal.create_booking'], ['view']);
    });
  });
});

describe('per-user extra access from this portal', () => {
  test('keeps the account\'s Employee Portal extras as stored', async () => {
    await withServer(app(), async (url) => {
      const admin = await account('Super Admin');
      const target = await account('Sales');
      await User.updateOne({ _id: target.user._id }, { $set: { extraGrants: [EMPLOYEE_CELLS[1]] } });

      const res = await put(url, `/api/v1/users/${target.user._id}/access`, {
        extraGrants: [{ module: 'inventory', submodule: 'ledger', actions: ['view'] }],
      }, admin.auth);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const { extraGrants } = await User.findById(target.user._id).lean();
      assert.deepEqual(extraGrants.map((g) => `${g.module}.${g.submodule}`).sort(),
        ['inventory.ledger', 'work_queue.tasks']);
    });
  });
});

describe('user administration writes check their own cell', () => {
  test('Sales may create a customer, but not an internal account', async () => {
    await withServer(app(), async (url) => {
      const sales = await account('Sales');
      const internal = await post(url, '/api/v1/users', {
        email: 'staff@example.com', password: 'x'.repeat(12), user: 'Staff', role: 'Sales',
      }, sales.auth);
      assert.equal(internal.status, 403);
      assert.match(internal.body.message, /only create customer accounts/);

      const customer = await post(url, '/api/v1/users', {
        email: 'shop@example.com', password: 'x'.repeat(12), user: 'A Shop', role: 'Customer',
      }, sales.auth);
      // Past the permission check: refused (if at all) for missing master data.
      assert.notEqual(customer.status, 403, JSON.stringify(customer.body));
    });
  });

  test('a role that may only VIEW internal users cannot create one', async () => {
    await Role.create({
      name: 'User Auditor', grants: [{ module: 'administration', submodule: 'users', actions: ['view'] }],
    });
    await loadRoles();
    await withServer(app(), async (url) => {
      const auditor = await account('User Auditor');
      assert.equal((await get(url, '/api/v1/users', auditor.auth)).status, 200, 'may open the screen');
      const res = await post(url, '/api/v1/users', {
        email: 'new@example.com', password: 'x'.repeat(12), user: 'New', role: 'Sales',
      }, auditor.auth);
      assert.equal(res.status, 403);
      assert.match(res.body.message, /permission to create internal accounts/);
    });
  });
});

describe('mergeServedGrants', () => {
  test('takes this portal\'s cells from the request and every other cell as stored', () => {
    const merged = mergeServedGrants(
      [...EMPLOYEE_CELLS, { module: 'sales', submodule: 'bookings', actions: ['view'] }],
      [{ module: 'inventory', submodule: 'ledger', actions: ['view'] }, { module: 'hrms', submodule: 'people', actions: ['view'] }],
      PORTALS.CUSTOMER,
    );
    assert.deepEqual(merged.map((g) => `${g.module}.${g.submodule}`).sort(),
      ['inventory.ledger', 'o2d.orders', 'work_queue.tasks']);
  });

  test('the served set is exactly this portal\'s', () => {
    const served = servedCellKeys(PORTALS.CUSTOMER);
    assert.ok(served.has('sales.bookings'));
    assert.ok(served.has('administration.customers'));
    assert.ok(!served.has('administration.roles'));
    assert.ok(!served.has('o2d.orders'));
  });

  test('flat keys follow the same rule', () => {
    assert.deepEqual(
      mergeServedPermissions(['view_o2d', 'view_pricing'], ['raise_po', 'view_o2d_analytics'], PORTALS.CUSTOMER).sort(),
      ['raise_po', 'view_o2d'],
    );
  });
});
