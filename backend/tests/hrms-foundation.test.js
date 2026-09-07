/**
 * Phase 1: the HRMS application foundation.
 *
 * Covers the Phase 1 test requirements that live on the backend:
 *   1.  A Customer cannot access HRMS.
 *   3.  Unauthorized HRMS routes are blocked.
 *   4.  Existing customer routes remain accessible.
 *   5.  Existing customer roles continue working.
 *   6.  HRMS roles can be assigned independently.
 *   7.  The HRMS route namespace works.
 *   9.  The HRMS API namespace is registered correctly.
 *   10. No DTA repository file is modified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hrmsAuthorizationChain } from '../middlewares/hrmsAuth.js';
import { getHrmsMe, getHrmsStatus } from '../modules/hrms/hrms.controller.js';
import companyRoutes from '../modules/hrms/company/company.routes.js';
import { hrmsErrorHandler, HrmsNotImplementedError, HrmsNotFoundError } from '../modules/hrms/hrms.errors.js';
import {
  IMPLEMENTED_HRMS_MODULES,
  PLANNED_HRMS_MODULES,
  isModuleImplemented,
} from '../modules/hrms/hrms.modules.js';
import {
  registerReferenceProvider,
  describe as describeReferences,
  referencesReady,
  resolveEmployee,
  resolveEmployeeByUser,
  resolveDepartment,
  resourceContextForEmployee,
  __resetReferenceProviders,
} from '../modules/hrms/references/reference.service.js';
import { validate } from '../middlewares/validate.js';
import { HRMS_ROLES as R, HRMS_MODULES as M } from '../shared/permissions/constants.js';
import { HRMS_API_PREFIX, HRMS_ROUTE_PREFIX } from '../shared/constants/hrms.js';
import { paginationQuery } from '../shared/validation/common.js';
import { buildTestApp, stubProtect, withServer, get, post } from './helpers/http.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

/** The HRMS router, behind a stub authenticator. Everything else is real. */
function hrmsAppFor(user) {
  return buildTestApp({
    mount: (app) => {
      const router = express.Router();
      router.use(stubProtect(user));
      router.use(hrmsAuthorizationChain);
      router.get('/me', getHrmsMe);
      router.get('/status', getHrmsStatus);
      router.use('/company', companyRoutes);
      router.use(hrmsErrorHandler);
      app.use(HRMS_API_PREFIX, router);
    },
  });
}

const CUSTOMER = { _id: 'c1', role: 'Customer', roles: [], status: 'Active' };
const HR_ADMIN = { _id: 'u1', role: 'Admin', roles: [R.HR_ADMIN], status: 'Active' };
const EMPLOYEE = { _id: 'u2', role: 'Sales', roles: [R.EMPLOYEE], status: 'Active' };

// ---------------------------------------------------------------------------
// 7 + 9: the namespace
// ---------------------------------------------------------------------------

test('the HRMS API namespace is /api/v1/hrms and the route prefix is /hrms', () => {
  assert.equal(HRMS_API_PREFIX, '/api/v1/hrms');
  assert.equal(HRMS_ROUTE_PREFIX, '/hrms');
});

test('the HRMS router is mounted in app.js under its own namespace', async () => {
  const app = await src('../app.js');
  assert.match(app, /app\.use\('\/api\/v1\/hrms', hrmsRoutes\)/);
  // The portal's own mounts must be untouched and still ahead of the catch-all.
  for (const p of ['auth', 'users', 'orders', 'reservations', 'notifications', 'roles', 'sales', 'inventory']) {
    assert.match(app, new RegExp(`app\\.use\\('/api/v1/${p}'`), `portal mount /${p} is missing`);
  }
});

test('the HRMS router mounts the foundation endpoints and its own error handler', async () => {
  const router = await src('../modules/hrms/hrms.routes.js');
  assert.match(router, /router\.get\('\/me', getHrmsMe\)/);
  assert.match(router, /router\.get\('\/status', getHrmsStatus\)/);
  assert.match(router, /router\.use\('\/company', companyRoutes\)/);
  assert.match(router, /router\.use\(hrmsErrorHandler\)/);
  // The guard chain still comes first.
  assert.ok(
    router.indexOf('hrmsAuthorizationChain') < router.indexOf("router.get('/me'"),
    'the authorization chain must be applied before any route',
  );
});

// ---------------------------------------------------------------------------
// 1 + 3: customer isolation across the whole namespace
// ---------------------------------------------------------------------------

const HRMS_ENDPOINTS = ['/me', '/status', '/company'];

test('a Customer is refused every HRMS endpoint in the namespace', async () => {
  await withServer(hrmsAppFor(CUSTOMER), async (url) => {
    for (const ep of HRMS_ENDPOINTS) {
      const res = await get(url, `${HRMS_API_PREFIX}${ep}`);
      assert.equal(res.status, 403, `${ep} should be 403 for a Customer`);
      assert.equal(res.body.success, false);
    }
  });
});

test('an unauthenticated request to the HRMS namespace is 401', async () => {
  await withServer(hrmsAppFor(null), async (url) => {
    for (const ep of HRMS_ENDPOINTS) {
      assert.equal((await get(url, `${HRMS_API_PREFIX}${ep}`)).status, 401);
    }
  });
});

test('an HRMS user without the settings permission cannot write the company profile', async () => {
  // Only the WRITE path is exercised over HTTP: the guard runs before the
  // controller, so the 403 needs no database. The read path would reach
  // CompanyProfile.load() and hang without Mongo, so its permission is asserted
  // at the source instead - see the next test.
  await withServer(hrmsAppFor(EMPLOYEE), async (url) => {
    const res = await fetch(`${url}${HRMS_API_PREFIX}/company`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legalName: 'Hijacked Ltd' }),
    });
    assert.equal(res.status, 403);
  });
});

test('the company profile is readable by any HRMS user and writable only by settings', async () => {
  const code = await src('../modules/hrms/company/company.routes.js');
  // Read: the shell header shows the company name on every screen, so the
  // baseline org-structure grant every HRMS role holds is enough.
  assert.match(code, /router\.get\(\s*'\/',\s*requirePermission\(\s*\{ module: M\.ORG_STRUCTURE/s);
  // Write: a settings action.
  assert.match(code, /router\.put\(\s*'\/',\s*requirePermission\(\{ module: M\.SETTINGS, action: A\.EDIT/s);
});

// ---------------------------------------------------------------------------
// 6 + 5: role independence, no customer regression
// ---------------------------------------------------------------------------

test('HRMS roles are assignable independently of the portal role', async () => {
  // The same portal role, with and without an HRMS role, differs only in HRMS.
  await withServer(hrmsAppFor({ _id: 'u3', role: 'Sales', roles: [], status: 'Active' }), async (url) => {
    assert.equal((await get(url, `${HRMS_API_PREFIX}/me`)).status, 403);
  });
  await withServer(hrmsAppFor({ _id: 'u3', role: 'Sales', roles: [R.EMPLOYEE], status: 'Active' }), async (url) => {
    const res = await get(url, `${HRMS_API_PREFIX}/me`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.roleKeys, [R.EMPLOYEE]);
  });
});

test('the portal permission model is untouched by Phase 1', async () => {
  const { hasLegacyPermission, PERMISSIONS, LEGACY_ROLE_PERMISSIONS } = await import(
    '../shared/permissions/legacy.js'
  );
  assert.equal(hasLegacyPermission({ role: 'Customer' }, PERMISSIONS.CREATE_ORDER), true);
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.RAISE_PO), true);
  assert.equal(hasLegacyPermission({ role: 'Admin' }, PERMISSIONS.MANAGE_USERS), true);
  assert.deepEqual(LEGACY_ROLE_PERMISSIONS.Customer, [PERMISSIONS.CREATE_ORDER]);
});

// ---------------------------------------------------------------------------
// /status - honest module reporting
// ---------------------------------------------------------------------------

test('/status reports only modules that actually exist', async () => {
  await withServer(hrmsAppFor(HR_ADMIN), async (url) => {
    const { body } = await get(url, `${HRMS_API_PREFIX}/status`);
    // Asserted as a CONTAINS rather than an exact list. Modules are registered
    // by whichever piece of work ships them, and pinning the exact array turns
    // every new module into an unrelated edit to this line — which says nothing
    // about the invariant being protected.
    const reported = body.data.implementedModules;
    for (const built of [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE, M.LEAVE]) {
      assert.ok(reported.includes(built), `${built} has a screen and should be reported`);
      assert.ok(body.data.availableModules.includes(built), `${built} is available to HR`);
    }
    // Whatever is reported must be a real module key, not a typo.
    const known = new Set(Object.values(M));
    for (const module of reported) assert.ok(known.has(module), `${module} is not a module key`);
    // The placeholder has moved with every module that shipped. Every top-level
    // module now has a screen, so it points at a SUB-PERMISSION instead —
    // `employees:compensation` gates a field inside Employee Master and will
    // never be a module a user navigates to, which makes it a stable anchor.
    // The invariant is unchanged: a key without a screen must never be reported
    // as available.
    assert.equal(
      body.data.implementedModules.includes(M.EMPLOYEES_COMPENSATION),
      false,
      'an unbuilt module must never be reported as available',
    );
    // AD-5: Operations and Projects/Timesheets are out of scope, and the
    // module keys do not exist at all - so asserting `includes(M.OPERATIONS)`
    // would compare against undefined and pass whatever happened. The real
    // invariant is that no such key ever enters the vocabulary.
    for (const module of body.data.implementedModules) {
      assert.doesNotMatch(module, /operation|project|timesheet/i, module);
    }
  });
});

test('implemented and planned modules are disjoint and cover the matrix', () => {
  for (const built of [M.DASHBOARD, M.EMPLOYEES, M.ORG_STRUCTURE, M.LEAVE]) {
    assert.ok(IMPLEMENTED_HRMS_MODULES.includes(built), built);
  }
  assert.equal(isModuleImplemented(M.DASHBOARD), true);
  assert.equal(isModuleImplemented(M.EMPLOYEES), true);
  assert.equal(isModuleImplemented(M.ORG_STRUCTURE), true);
  assert.equal(isModuleImplemented(M.LEAVE), true);
  // Inbox landed, and with it the last of the top-level modules. The assertion
  // still guards the same thing — that `isModuleImplemented` tells the truth in
  // both directions.
  assert.equal(isModuleImplemented(M.PAYROLL), true, 'payroll is built');
  assert.equal(isModuleImplemented(M.PERFORMANCE), true, 'performance is built');
  assert.equal(isModuleImplemented(M.PLANNING), true, 'planning is built');
  assert.equal(isModuleImplemented(M.INBOX), true, 'inbox is built');
  assert.equal(
    isModuleImplemented(M.EMPLOYEES_COMPENSATION),
    false,
    'employees:compensation is a field-level grant, not a module with a screen',
  );
  for (const m of IMPLEMENTED_HRMS_MODULES) {
    assert.equal(PLANNED_HRMS_MODULES.includes(m), false, `${m} cannot be both`);
  }
  assert.equal(
    IMPLEMENTED_HRMS_MODULES.length + PLANNED_HRMS_MODULES.length,
    Object.values(M).length,
  );
});

// ---------------------------------------------------------------------------
// Employee reference foundation - fails clearly, never silently
// ---------------------------------------------------------------------------

test('an unregistered reference throws 503 rather than returning null', async (t) => {
  t.after(() => __resetReferenceProviders());
  __resetReferenceProviders();

  // Returning null would be indistinguishable from "that employee does not
  // exist", and a scope check would then evaluate against an empty team.
  await assert.rejects(() => resolveEmployee('abc'), (err) => {
    assert.ok(err instanceof HrmsNotImplementedError);
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /Employee Master lands in a later phase/);
    return true;
  });
  await assert.rejects(() => resolveEmployeeByUser('u1'), HrmsNotImplementedError);
  await assert.rejects(() => resolveDepartment('d1'), HrmsNotImplementedError);
});

test('describe() reports what is wired up without throwing', (t) => {
  t.after(() => __resetReferenceProviders());
  __resetReferenceProviders();
  assert.deepEqual(describeReferences(), { employee: false, department: false, location: false });
  assert.equal(referencesReady(), false);
});

test('a half-implemented reference provider is refused at registration', (t) => {
  t.after(() => __resetReferenceProviders());
  __resetReferenceProviders();

  assert.throws(() => registerReferenceProvider('employee', {}), /missing/);
  assert.throws(() => registerReferenceProvider('employee', { byId: async () => null }), /missing/);
  assert.throws(() => registerReferenceProvider('nonsense', { byId() {} }), /unknown reference kind/);
});

test('a registered provider resolves, and the resource context is derived once', async (t) => {
  t.after(() => __resetReferenceProviders());
  __resetReferenceProviders();

  registerReferenceProvider('employee', {
    byId: async (id) =>
      id === 'e1'
        ? {
            id: 'e1',
            employeeCode: 'E001',
            displayName: 'Priya Sharma',
            departmentId: 'd1',
            locationId: 'l1',
            reportingManagerId: 'm1',
            managerChain: ['m1', 'm2'],
            userId: 'u1',
            status: 'active',
          }
        : null,
    byUserId: async () => null,
    byCodes: async () => new Map(),
    byIds: async () => new Map(),
  });

  assert.equal(describeReferences().employee, true);
  assert.equal((await resolveEmployee('e1')).employeeCode, 'E001');
  // A genuine "no such employee" still comes back as null.
  assert.equal(await resolveEmployee('nope'), null);

  const ctx = await resourceContextForEmployee('e1');
  assert.deepEqual(ctx, {
    ownerUserId: 'u1',
    ownerEmployeeId: 'e1',
    ownerDepartmentId: 'd1',
    ownerManagerChain: ['m1', 'm2'],
  });
  assert.equal(await resourceContextForEmployee('nope'), undefined);
});

test('the bootstrap bridges the actor lookup onto the reference service', async () => {
  const code = await src('../modules/hrms/hrms.bootstrap.js');
  assert.match(code, /setEmployeeResolver/);
  assert.match(code, /resolveEmployeeByUser/);
  // With no provider it must return null, not throw - Phase 1 has no module
  // that needs team scope, and throwing would break every HRMS request.
  assert.match(code, /if \(!describeReferences\(\)\.employee\)/);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('HRMS errors carry a status and a stable code', () => {
  const nf = new HrmsNotFoundError('Department');
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.code, 'HRMS_NOT_FOUND');
  assert.equal(nf.toResponse().success, false);

  const ni = new HrmsNotImplementedError('Payroll');
  assert.equal(ni.statusCode, 503, 'not built is not a server fault');
  assert.equal(ni.code, 'HRMS_NOT_IMPLEMENTED');
});

test('the HRMS error handler converts them, and passes anything else on', async () => {
  const app = buildTestApp({
    mount: (a) => {
      const router = express.Router();
      router.get('/known', () => {
        throw new HrmsNotFoundError('Widget');
      });
      router.get('/unknown', () => {
        throw new Error('boom');
      });
      router.use(hrmsErrorHandler);
      a.use('/x', router);
    },
  });

  await withServer(app, async (url) => {
    const known = await get(url, '/x/known');
    assert.equal(known.status, 404);
    assert.equal(known.body.code, 'HRMS_NOT_FOUND');

    // Falls through to the app-wide handler, unchanged.
    assert.equal((await get(url, '/x/unknown')).status, 500);
  });
});

// ---------------------------------------------------------------------------
// Validation middleware
// ---------------------------------------------------------------------------

test('validate() parses and replaces the request part, and reports where it failed', async () => {
  const app = buildTestApp({
    mount: (a) => {
      a.get('/list', validate({ query: paginationQuery }), (req, res) =>
        res.json({ success: true, data: req.query }),
      );
    },
  });

  await withServer(app, async (url) => {
    // Query strings arrive as text; the handler must see numbers.
    const ok = await get(url, '/list?page=3&pageSize=50');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.page, 3);
    assert.equal(typeof ok.body.data.page, 'number');
    assert.equal(ok.body.data.sortDir, 'asc', 'defaults are applied');

    const bad = await get(url, '/list?page=0');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.errors[0].in, 'query');
    assert.ok(bad.body.errors[0].path);
  });
});

test('validate() refuses to be wired with no schema', () => {
  assert.throws(() => validate({}), TypeError);
});

// ---------------------------------------------------------------------------
// AD-1: single tenant
// ---------------------------------------------------------------------------

test('CompanyProfile replaces Organization and carries no tenancy', async () => {
  // Comments stripped: the file EXPLAINS that it carries no organizationId, and
  // a naive match would find the explanation rather than the code.
  const code = (await src('../models/hrms/CompanyProfile.js'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(code, /key: \{ type: String, default: 'company-profile', unique: true, immutable: true \}/);
  // The things AD-1 forbids.
  assert.doesNotMatch(code, /organizationId/);
  assert.doesNotMatch(code, /withOrg|AsyncLocalStorage|RowLevelSecurity/);
  // AD-12: no default state. Null must block payroll, not fall back.
  assert.match(code, /defaultStateCode/);
  assert.match(code, /default: null/);
});

test('no HRMS model carries an organizationId (AD-1)', async () => {
  const dir = path.join(BACKEND, 'models', 'hrms');
  const walk = async (d) => {
    const out = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  for (const file of await walk(dir)) {
    const code = await readFile(file, 'utf8');
    assert.doesNotMatch(
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
      /organizationId/,
      `${path.relative(BACKEND, file)} must not carry a tenant id`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10: the reference repository is untouched
// ---------------------------------------------------------------------------

test('no DTA_HRMS file has been modified during implementation', async () => {
  const dta = path.resolve(BACKEND, '..', '..', 'DTA_HRMS');

  let exists = true;
  try {
    await stat(dta);
  } catch {
    exists = false;
  }
  if (!exists) {
    // Not checked out beside the portal in this environment.
    return;
  }

  // The session that built Phase 0 began after this instant; anything modified
  // since would have been touched by the implementation.
  const PHASE_START = new Date('2026-09-01T13:00:00Z').getTime();
  const offenders = [];

  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const s = await stat(full);
        if (s.mtimeMs > PHASE_START) offenders.push(path.relative(dta, full));
      }
    }
  };
  await walk(dta);

  assert.deepEqual(
    offenders,
    [],
    `DTA_HRMS is read-only reference material:\n${offenders.join('\n')}`,
  );
});
