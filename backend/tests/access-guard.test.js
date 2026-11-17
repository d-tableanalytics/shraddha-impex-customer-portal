/**
 * The dynamic-RBAC hardening: who may hand out access, tokens, role renames,
 * and cross-process role sync.
 *
 * Each test pins a hole the RBAC audit found open:
 *   - a refresh token worked as an access token;
 *   - a user administrator could make any account (their own included) Super
 *     Admin, and could demote the last one;
 *   - renaming a role stranded everyone who held it;
 *   - a role saved by the OTHER portal's server never reached this one.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import express from 'express';

import { startTestMongo, stopTestMongo, clearCollections, syncIndexes } from './helpers/mongo.js';
import { buildTestApp, stubProtect, withServer, get, patch } from './helpers/http.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { protect } from '../middlewares/auth.js';
import { signAccessToken, signRefreshToken } from '../utils/tokens.js';
import { loadRoles, syncRoles, resolveRolePermissions, onRolesChanged } from '../utils/roleResolver.js';
import { assignRoleProblem, deactivateProblem, editRoleProblem, actOnAccountProblem } from '../utils/accessGuard.js';
import roleRoutes from '../modules/roles/role.routes.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

before(async () => {
  await startTestMongo();
  await syncIndexes(Role, User, AuditLog);
});
after(async () => { await stopTestMongo(); });
beforeEach(async () => {
  await clearCollections();
  await loadRoles();
});

let seq = 0;
const makeUser = (fields) => User.create({
  user: `U${++seq}`, email: `u${seq}@example.test`, password: 'irrelevant-hash', status: 'Active', ...fields,
});

describe('tokens', () => {
  const app = () => {
    const a = express();
    a.get('/me', protect, (req, res) => res.json({ id: String(req.user._id) }));
    return a;
  };

  test('an access token opens the API', async () => {
    const u = await makeUser({ role: 'Sales' });
    await withServer(app(), async (url) => {
      const res = await get(url, '/me', { headers: { Authorization: `Bearer ${signAccessToken(u._id)}` } });
      assert.equal(res.status, 200);
    });
  });

  test('a refresh token does not, even though it verifies against the same secret', async () => {
    const u = await makeUser({ role: 'Sales' });
    const refresh = signRefreshToken(u._id);
    const token = typeof refresh === 'string' ? refresh : refresh.token;
    assert.equal(jwt.decode(token).type, 'refresh');
    await withServer(app(), async (url) => {
      const res = await get(url, '/me', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 401);
    });
  });
});

describe('assigning roles', () => {
  test('nobody below Super Admin assigns a full-access role, or changes a full-access account', async () => {
    const userAdmin = await Role.create({ name: 'User Admin', grants: [{ module: 'administration', submodule: 'users', actions: ['view', 'create', 'edit'] }] });
    await loadRoles();
    const actor = await makeUser({ role: userAdmin.name });
    const boss = await makeUser({ role: 'Super Admin' });

    assert.equal((await assignRoleProblem(actor, null, 'Super Admin')).code, 'ROLE_ABOVE_ACTOR');
    assert.equal((await assignRoleProblem(actor, boss, 'Sales')).status, 403);
    assert.equal(actOnAccountProblem(actor, boss).code, 'TARGET_ABOVE_ACTOR');
  });

  test('nobody changes their own role, and nobody hands on access they lack', async () => {
    const userAdmin = await Role.create({ name: 'User Admin', grants: [{ module: 'administration', submodule: 'users', actions: ['view', 'edit'] }] });
    await loadRoles();
    const actor = await makeUser({ role: userAdmin.name });

    assert.equal((await assignRoleProblem(actor, actor, 'Sales')).code, 'SELF_ROLE_CHANGE');
    const other = await makeUser({ role: 'Warehouse User' });
    assert.equal((await assignRoleProblem(actor, other, 'Sales')).code, 'ROLE_ABOVE_ACTOR');
  });

  test('a customer account can still be created by someone who is not a customer', async () => {
    const sales = await makeUser({ role: 'Sales' });
    assert.equal(await assignRoleProblem(sales, null, 'Customer'), null);
  });

  test('the last active Super Admin cannot be demoted or suspended', async () => {
    const only = await makeUser({ role: 'Super Admin' });
    const admin = await makeUser({ role: 'Super Admin' });
    // Two of them: either may move the other.
    assert.equal(await assignRoleProblem(admin, only, 'Sales'), null);
    await User.updateOne({ _id: admin._id }, { $set: { status: 'Inactive' } });
    // Now `only` really is the last active one.
    const actor = { _id: new mongoose.Types.ObjectId(), role: 'Super Admin', status: 'Active' };
    assert.equal((await assignRoleProblem(actor, only, 'Sales')).code, 'LAST_SUPER_ADMIN');
    assert.equal((await deactivateProblem(actor, only)).code, 'LAST_SUPER_ADMIN');
  });
});

describe('editing roles', () => {
  test('a role editor cannot widen its own role, nor grant a key it lacks', async () => {
    const editor = await Role.create({ name: 'Role Editor', grants: [{ module: 'administration', submodule: 'roles', actions: ['view', 'edit'] }] });
    await loadRoles();
    const actor = await makeUser({ role: editor.name });

    assert.equal(editRoleProblem(actor, editor.toObject(), []).code, 'SELF_ROLE_EDIT');
    const other = await Role.create({ name: 'Other' });
    assert.equal(editRoleProblem(actor, other.toObject(), ['manage_users']).code, 'GRANT_ABOVE_ACTOR');
  });

  test('renaming a role moves everyone who holds it, and is audited with before/after', async () => {
    const custom = await Role.create({ name: 'Stock Checker', grants: [{ module: 'inventory', submodule: 'master', actions: ['view'] }] });
    await loadRoles();
    const holder = await makeUser({ role: 'Stock Checker' });
    const admin = await makeUser({ role: 'Super Admin' });

    const app = buildTestApp({
      mount: (a) => {
        a.use(stubProtect(admin.toObject()));
        a.use('/api/v1/roles', roleRoutes);
      },
    });
    await withServer(app, async (url) => {
      const res = await patch(url, `/api/v1/roles/${custom._id}`, { name: 'Stock Auditor' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    assert.equal((await User.findById(holder._id).lean()).role, 'Stock Auditor');
    assert.ok(resolveRolePermissions('Stock Auditor').includes('view_inventory'), 'the holder keeps the access');
    const entry = await AuditLog.findOne({ action: 'Role Updated' }).lean();
    assert.equal(entry.meta.before.name, 'Stock Checker');
    assert.equal(entry.meta.after.name, 'Stock Auditor');
  });
});

describe('cross-process role sync', () => {
  test('a change written by another server is picked up and announced', async () => {
    await Role.create({ name: 'Floor Lead', grants: [{ module: 'inventory', submodule: 'master', actions: ['view'] }] });
    await syncRoles(); // baseline snapshot
    assert.ok(resolveRolePermissions('Floor Lead').includes('view_inventory'));

    let announced = 0;
    const stop = onRolesChanged(() => { announced += 1; });

    // The other portal revokes the cell straight in the shared collection.
    await new Promise((r) => setTimeout(r, 5));
    await Role.updateOne({ name: 'Floor Lead' }, { $set: { grants: [] } });
    assert.equal(await syncRoles(), true);
    stop();

    assert.ok(!resolveRolePermissions('Floor Lead').includes('view_inventory'), 'revocation applied without a restart');
    assert.equal(announced, 1, 'listeners (live sessions) are told');
    assert.equal(await syncRoles(), false, 'no change, no reload');
  });
});

describe('audit of refusals', () => {
  test('a 403 from the permission check is recorded once per user and endpoint per minute', async () => {
    process.env.AUDIT_DENIED_IN_TESTS = '1';
    const { authorize } = await import('../middlewares/rbac.js');
    const customer = await makeUser({ role: 'Customer' });
    const app = buildTestApp({
      mount: (a) => {
        a.use(stubProtect(customer.toObject()));
        a.get('/secret', authorize('manage_users'), (req, res) => res.json({ ok: true }));
      },
    });
    await withServer(app, async (url) => {
      assert.equal((await get(url, '/secret')).status, 403);
      assert.equal((await get(url, '/secret')).status, 403);
    });
    await new Promise((r) => setTimeout(r, 50)); // the audit write is fire-and-forget
    const rows = await AuditLog.find({ action: 'Access Denied' }).lean();
    delete process.env.AUDIT_DENIED_IN_TESTS;
    assert.equal(rows.length, 1, 'throttled to one row');
    assert.match(rows[0].remarks, /manage_users/);
    assert.equal(String(rows[0].user), String(customer._id));
  });
});

describe('the customer ceiling', () => {
  test('a desk-only key ticked on a portal-only role never reaches its customers', async () => {
    const { resolveUserPermissions } = await import('../utils/roleResolver.js');
    await Role.create({
      name: 'Customer Plus',
      portalOnly: true,
      grants: [
        { module: 'customer_portal', submodule: 'booking_history', actions: ['view', 'edit', 'delete'] },
        { module: 'customer_portal', submodule: 'create_booking', actions: ['view', 'create'] },
      ],
    });
    await loadRoles();
    const perms = resolveUserPermissions({ role: 'Customer Plus', extraGrants: [] });
    assert.ok(perms.includes('view_orders'), 'customer reads still allowed');
    assert.ok(perms.includes('create_order'), 'customer booking still allowed');
    for (const key of ['manage_orders', 'edit_booking_pre_po', 'view_all_bookings']) {
      assert.ok(!perms.includes(key), `${key} is fenced out`);
    }
  });
});
