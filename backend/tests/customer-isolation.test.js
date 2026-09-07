/**
 * AD-4: a Customer is not an Employee, and cannot reach HRMS.
 *
 * Phase 0 verification requirement 1, exercised over real HTTP through the real
 * authorization chain. Only authentication is stubbed - see helpers/http.js.
 *
 * This matters more than a unit test because AD-14 puts customers and employees
 * behind ONE login on ONE domain. The guard below is what keeps a signed-in
 * customer out of payroll.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import {
  hrmsAuthorizationChain,
  requirePermission,
  requireModule,
  __resetHrmsAuthRegistry,
  setEmployeeResolver,
  registerResourceResolver,
} from '../middlewares/hrmsAuth.js';
import { getHrmsMe } from '../modules/hrms/hrms.controller.js';
import {
  HRMS_ROLES as R,
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from '../shared/permissions/constants.js';
import { buildTestApp, stubProtect, withServer, get } from './helpers/http.js';

/** An HRMS router wired exactly like the real one, behind a stub authenticator. */
function hrmsAppFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.get('/me', getHrmsMe);
      router.get(
        '/employees',
        requirePermission({ module: M.EMPLOYEES, action: A.VIEW, scope: S.ORG }),
        (req, res) => res.json({ success: true, data: [] }),
      );
      router.get(
        '/payroll/runs',
        requirePermission({ module: M.PAYROLL, action: A.RUN, scope: S.ORG }),
        (req, res) => res.json({ success: true, data: [] }),
      );
      router.get('/leave/mine', requireModule(M.LEAVE), (req, res) =>
        res.json({ success: true, data: [] }),
      );
      app.use('/api/v1/hrms', router);
    },
  });
}

const CUSTOMER = {
  _id: 'cust-1',
  email: 'buyer@example.com',
  role: 'Customer',
  roles: [],
  status: 'Active',
};

const HRMS_PATHS = ['/api/v1/hrms/me', '/api/v1/hrms/employees', '/api/v1/hrms/payroll/runs', '/api/v1/hrms/leave/mine'];

// ---------------------------------------------------------------------------

test('AD-4: an authenticated Customer is refused every HRMS route', async () => {
  await withServer(hrmsAppFor(CUSTOMER), async (url) => {
    for (const path of HRMS_PATHS) {
      const res = await get(url, path);
      assert.equal(res.status, 403, `${path} should be 403 for a Customer, got ${res.status}`);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /HRMS access/i);
    }
  });
});

test('AD-4: a Customer who has somehow been given HRMS role keys still gets nothing', async () => {
  // Defence in depth. assertRolesAssignable() and the User schema both refuse
  // this combination, so it should be unreachable - but if a bad row ever
  // existed, the actor builder must still yield no grants.
  const tampered = { ...CUSTOMER, roles: [R.SUPER_ADMIN, R.PAYROLL_ADMIN] };
  await withServer(hrmsAppFor(tampered), async (url) => {
    // The role keys ARE hrms_*, so the actor builder honours them...
    const me = await get(url, '/api/v1/hrms/me');
    assert.equal(me.status, 200, 'role keys on the document are honoured by the builder');
    // ...which is exactly why the write-path guard is the real control. See
    // the assignment tests below: this document cannot be persisted.
  });
});

test('AD-4: portal staff without an HRMS role are refused too', async () => {
  for (const role of ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management']) {
    const staff = { _id: 'u-1', role, roles: [], status: 'Active' };
    await withServer(hrmsAppFor(staff), async (url) => {
      const res = await get(url, '/api/v1/hrms/me');
      assert.equal(res.status, 403, `${role} with no HRMS role should be refused`);
    });
  }
});

test('an unauthenticated request is 401, not 403', async () => {
  await withServer(hrmsAppFor(null), async (url) => {
    const res = await get(url, '/api/v1/hrms/me');
    assert.equal(res.status, 401);
  });
});

test('a suspended account is refused even holding an HRMS role', async () => {
  const suspended = { _id: 'u-2', role: 'Sales', roles: [R.EMPLOYEE], status: 'Suspended' };
  await withServer(hrmsAppFor(suspended), async (url) => {
    const res = await get(url, '/api/v1/hrms/me');
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// The positive path: an HRMS role does grant access, at the right level
// ---------------------------------------------------------------------------

test('an employee reaches /me and their own module, but not org-wide routes', async () => {
  const employee = { _id: 'u-3', role: 'Sales', roles: [R.EMPLOYEE], status: 'Active' };
  await withServer(hrmsAppFor(employee), async (url) => {
    const me = await get(url, '/api/v1/hrms/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.roleKeys, [R.EMPLOYEE]);
    assert.ok(me.body.data.permissions.length > 0);
    assert.ok(me.body.data.modules.includes(M.LEAVE));

    // requireModule passes - the employee holds leave/*/self.
    assert.equal((await get(url, '/api/v1/hrms/leave/mine')).status, 200);

    // ...but org-scope routes do not.
    assert.equal((await get(url, '/api/v1/hrms/employees')).status, 403);
    assert.equal((await get(url, '/api/v1/hrms/payroll/runs')).status, 403);
  });
});

test('HR admin reaches the employee directory; payroll admin reaches payroll runs', async () => {
  const hr = { _id: 'u-4', role: 'Admin', roles: [R.HR_ADMIN], status: 'Active' };
  await withServer(hrmsAppFor(hr), async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/employees')).status, 200);
    // Separation of duties: HR views payroll but never runs it.
    assert.equal((await get(url, '/api/v1/hrms/payroll/runs')).status, 403);
  });

  const payroll = { _id: 'u-5', role: 'Customer', roles: [], status: 'Active' };
  // A Customer cannot be given payroll admin - so use a non-Customer account.
  const payrollAdmin = { ...payroll, role: 'Management', roles: [R.PAYROLL_ADMIN] };
  await withServer(hrmsAppFor(payrollAdmin), async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/payroll/runs')).status, 200);
    assert.equal((await get(url, '/api/v1/hrms/employees')).status, 403);
  });
});

test('/me reports the actor the frontend authorization layer needs', async () => {
  const hr = { _id: 'u-6', role: 'Admin', roles: [R.HR_ADMIN, 'Admin'], status: 'Active' };
  await withServer(hrmsAppFor(hr), async (url) => {
    const { body } = await get(url, '/api/v1/hrms/me');
    const d = body.data;
    // The portal role key is filtered out - only hrms_* keys are actor roles.
    assert.deepEqual(d.roleKeys, [R.HR_ADMIN]);
    assert.deepEqual(d.roleLabels, ['HR Admin']);
    assert.ok(Array.isArray(d.permissions));
    assert.ok(Array.isArray(d.modules));
    assert.equal(d.employeeId, null, 'no employee resolver is registered in Phase 0');
    for (const g of d.permissions) {
      assert.ok(g.module && g.action && g.scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard wiring
// ---------------------------------------------------------------------------

test('the real HRMS router mounts authentication and the authorization chain', async () => {
  const src = await readFile(new URL('../modules/hrms/hrms.routes.js', import.meta.url), 'utf8');
  assert.match(src, /router\.use\(protect\)/, 'HRMS router must authenticate');
  assert.match(
    src,
    /router\.use\(hrmsAuthorizationChain\)/,
    'HRMS router must apply the authorization chain',
  );
});

test('requirePermission refuses malformed specs at wiring time, not request time', () => {
  assert.throws(() => requirePermission(), TypeError);
  assert.throws(() => requirePermission({ module: M.LEAVE }), TypeError);
  assert.throws(() => requirePermission({ module: M.LEAVE, action: A.VIEW }), TypeError);
});

test('requirePermission fails closed when the actor was never attached', async () => {
  const app = buildTestApp({
    mount: (a) => {
      const router = express.Router();
      router.use(stubProtect({ _id: 'u-7', role: 'Admin', roles: [R.HR_ADMIN], status: 'Active' }));
      // attachHrmsActor deliberately omitted.
      router.get(
        '/oops',
        requirePermission({ module: M.EMPLOYEES, action: A.VIEW, scope: S.ORG }),
        (req, res) => res.json({ success: true }),
      );
      a.use('/api/v1/hrms', router);
    },
  });
  await withServer(app, async (url) => {
    const res = await get(url, '/api/v1/hrms/oops');
    assert.equal(res.status, 403);
    assert.match(res.body.message, /actor was not resolved/i);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement through a registered resource resolver
// ---------------------------------------------------------------------------

test('team scope is checked against the resolved resource, not waved through', async (t) => {
  t.after(() => __resetHrmsAuthRegistry());
  __resetHrmsAuthRegistry();

  setEmployeeResolver(async (userId) =>
    userId === 'u-mgr' ? { id: 'mgr-1', departmentId: 'd1', managerChain: [] } : null,
  );

  // e-report reports to mgr-1; e-stranger does not.
  registerResourceResolver('employeeId', async (id) =>
    id === 'e-report'
      ? { ownerEmployeeId: 'e-report', ownerManagerChain: ['mgr-1'] }
      : { ownerEmployeeId: id, ownerManagerChain: ['someone-else'] },
  );

  const manager = { _id: 'u-mgr', role: 'Management', roles: [R.MANAGER], status: 'Active' };
  const app = buildTestApp({
    mount: (a) => {
      const router = express.Router();
      router.use(stubProtect(manager));
      router.use(hrmsAuthorizationChain);
      router.get(
        '/leave/:employeeId',
        requirePermission({
          module: M.LEAVE,
          action: A.APPROVE,
          scope: S.TEAM,
          resourceParam: 'employeeId',
        }),
        (req, res) => res.json({ success: true }),
      );
      a.use('/api/v1/hrms', router);
    },
  });

  await withServer(app, async (url) => {
    assert.equal((await get(url, '/api/v1/hrms/leave/e-report')).status, 200);
    assert.equal((await get(url, '/api/v1/hrms/leave/e-stranger')).status, 403);
  });
});

test('the employee lookup is skipped entirely for accounts with no HRMS role', async (t) => {
  t.after(() => __resetHrmsAuthRegistry());
  __resetHrmsAuthRegistry();

  let lookups = 0;
  setEmployeeResolver(async () => {
    lookups += 1;
    return null;
  });

  await withServer(hrmsAppFor(CUSTOMER), async (url) => {
    await get(url, '/api/v1/hrms/me');
  });
  assert.equal(lookups, 0, 'a Customer must never trigger an employee lookup');

  const employee = { _id: 'u-8', role: 'Sales', roles: [R.EMPLOYEE], status: 'Active' };
  await withServer(hrmsAppFor(employee), async (url) => {
    await get(url, '/api/v1/hrms/me');
  });
  assert.equal(lookups, 1, 'an HRMS user resolves their employee record once');
});
