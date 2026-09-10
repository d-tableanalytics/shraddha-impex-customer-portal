/**
 * The seam between the two authorization systems.
 *
 * The portal's model and the HRMS model now live in one process, and the whole
 * risk of that is CROSSOVER: a portal permission leaking into HRMS, or an HRMS
 * role landing on an account the portal has fenced into the customer area.
 * Neither system's own tests can catch that, because each is right about its
 * own half. These are the tests about the boundary between them.
 *
 * The one that matters most is the wildcard. `setHas` answers true for EVERY
 * flat key when a role resolves to `['*']`, and production has two Admin
 * accounts. If HRMS permissions were ever expressed as flat keys, those
 * accounts would silently hold payroll, PAN and audit access. They are not, and
 * this is what says so out loud.
 */

/*
 * WHAT THIS FILE STILL COVERS, NOW THAT HRMS HAS LEFT THIS REPOSITORY
 *
 * The scope tests that needed a real Employee document went with HRMS — they
 * exercise employee self/team/department scope, which is the Employee Portal's
 * to prove and which its own copy of this file still does.
 *
 * Everything below stayed, and is the reason this file was not simply deleted:
 * it is the AD-4 FENCE, and the fence has to be tested wherever the WRITING
 * happens. This backend still creates and edits accounts in the shared `users`
 * collection, so it is still capable of putting an `hrms_*` key on a customer —
 * and the Employee Portal would honour it. `utils/hrmsRoleGuard.js`, the schema
 * hook and `updateUserAccess` are what stop that, and they are all asserted here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import User from '../models/User.js';
import Role from '../models/Role.js';
import { PERMISSIONS, hasPermission, permissionsFor } from '../middlewares/rbac.js';
import { loadRoles } from '../utils/roleResolver.js';
import { assertHrmsRolesAssignable, isPortalOnlyRole } from '../utils/hrmsRoleGuard.js';
import { RoleAssignmentError } from '../shared/permissions/assignment.js';
import {
  buildHrmsActor,
  hasHrmsPermission,
  hasAnyHrmsAccess,
} from '../shared/permissions/has-permission.js';
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
  HRMS_ROLES as R,
  HRMS_MODULE_LIST,
  HRMS_ACTION_LIST,
} from '../shared/permissions/constants.js';
import { startTestMongo, stopTestMongo, syncIndexes, clearCollections } from './helpers/mongo.js';

test.before(async () => {
  await startTestMongo();
  await syncIndexes(User, Role);
});

test.after(async () => {
  await stopTestMongo();
});

test.beforeEach(async () => {
  await clearCollections();
  await loadRoles(); // empty collection -> baseline only, which is the point
});

// ---------------------------------------------------------------------------
// 1 + 2. A portal role, including the wildcard, reaches no HRMS permission
// ---------------------------------------------------------------------------

test('a portal Admin with no HRMS role holds ZERO HRMS permissions', () => {
  const admin = { role: 'Admin', roles: [] };

  // The portal half: unrestricted, exactly as before.
  assert.deepEqual(permissionsFor(admin), ['*']);
  for (const key of Object.values(PERMISSIONS)) {
    assert.equal(hasPermission(admin, key), true, `Admin must still hold ${key}`);
  }

  // The HRMS half: nothing at all.
  const actor = buildHrmsActor({ userId: 'u1', roles: admin.roles, legacyRole: admin.role });
  assert.equal(hasAnyHrmsAccess(actor), false);
  assert.deepEqual(actor.roleKeys, []);
  assert.deepEqual(actor.permissions, []);
});

test("the portal wildcard '*' satisfies no HRMS module, action or scope", () => {
  // The failure this rules out: HRMS expressed as flat keys, where `setHas`
  // would answer true for every one of them on a wildcard role.
  const admin = { role: 'Admin', roles: [] };
  assert.equal(hasPermission(admin, '*'), true, 'the portal wildcard is real');
  assert.equal(hasPermission(admin, 'a_key_nobody_defined'), true, 'and it is total');

  const actor = buildHrmsActor({ roles: admin.roles, legacyRole: 'Admin' });
  for (const module of HRMS_MODULE_LIST) {
    for (const action of HRMS_ACTION_LIST) {
      for (const scope of [S.SELF, S.TEAM, S.DEPARTMENT, S.ORG]) {
        assert.equal(
          hasHrmsPermission(actor, module, action, scope),
          false,
          `Admin must not reach ${module}:${action}:${scope}`,
        );
      }
    }
  }
});

test('Super Admin is unrestricted in the portal and still holds no HRMS access', () => {
  const superAdmin = { role: 'Super Admin', roles: [] };
  assert.deepEqual(permissionsFor(superAdmin), ['*']);

  const actor = buildHrmsActor({ roles: superAdmin.roles, legacyRole: superAdmin.role });
  assert.equal(hasAnyHrmsAccess(actor), false);
  assert.equal(hasHrmsPermission(actor, M.PAYROLL, A.VIEW, S.ORG), false);
  assert.equal(hasHrmsPermission(actor, M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG), false);
  assert.equal(hasHrmsPermission(actor, M.AUDIT_LOGS, A.VIEW, S.ORG), false);
});

// ---------------------------------------------------------------------------
// 3 + 4. AD-4, widened: no PORTAL-ONLY role may hold an HRMS role
// ---------------------------------------------------------------------------

test('a Customer cannot receive an HRMS role', () => {
  assert.equal(isPortalOnlyRole('Customer'), true);
  assert.throws(
    () => assertHrmsRolesAssignable('Customer', [R.EMPLOYEE]),
    (err) => err instanceof RoleAssignmentError && err.code === 'CUSTOMER_CANNOT_HOLD_HRMS_ROLE',
  );
});

test('a CUSTOM portal-only role cannot receive an HRMS role either', async () => {
  // The hole the widening closes. A Super Admin invents 'Dealer', marks it
  // portalOnly, and the old rule - which compared against the literal string
  // 'Customer' - would have let a Dealer hold hrms_employee and reach payroll.
  await Role.create({ name: 'Dealer', portalOnly: true, grants: [], permissions: [] });
  await loadRoles();

  assert.equal(isPortalOnlyRole('Dealer'), true, 'the flag must be read from the role document');
  assert.throws(
    () => assertHrmsRolesAssignable('Dealer', [R.EMPLOYEE]),
    (err) => err instanceof RoleAssignmentError,
  );

  // And a custom role that is NOT portal-only is unaffected: staff roles may
  // legitimately hold HRMS roles.
  await Role.create({ name: 'Ops Lead', portalOnly: false, grants: [], permissions: [] });
  await loadRoles();
  assert.equal(isPortalOnlyRole('Ops Lead'), false);
  assert.equal(assertHrmsRolesAssignable('Ops Lead', [R.EMPLOYEE]), true);
});

test('the schema hook refuses a portal-only account holding an HRMS role', async () => {
  await Role.create({ name: 'Dealer', portalOnly: true, grants: [], permissions: [] });
  await loadRoles();

  await assert.rejects(
    User.create({
      email: 'dealer@example.net',
      password: 'x'.repeat(20),
      user: 'A Dealer',
      role: 'Dealer',
      roles: [R.EMPLOYEE],
    }),
    (err) => /customer portal|mutually exclusive/i.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// 5 + 6. extraGrants cannot become a second way into HRMS
// ---------------------------------------------------------------------------

test('extraGrants cannot carry an HRMS role, structurally', async () => {
  const { validateGrants, compileGrants, allRegistryKeys, keysForGrant } = await import(
    '../config/moduleRegistry.js'
  );

  /**
   * THE INVARIANT, WHICH IS UNCHANGED.
   *
   * Nothing in the ERP registry compiles to an `hrms_` key. That is what makes
   * updateUserAccess safe: it refuses any grant compiling to a role key, and
   * this is the property that stops the matrix ever producing one.
   *
   * The registry DOES now carry an `hrms` module - that is how a Super Admin
   * grants HRMS access. Its cells compile to portal permission strings
   * (`access_hrms`, `administer_hrms`, ...), never to role keys. The
   * translation from those strings to `hrms_*` roles happens in
   * utils/hrmsAccessBridge.js, behind the portal fence, and not here.
   */
  for (const key of allRegistryKeys()) {
    assert.doesNotMatch(String(key), /^hrms_/, `the registry must not expose ${key}`);
  }

  // The HRMS cells exist, and every one of them compiles to portal strings.
  const hrmsKeys = keysForGrant('hrms', 'administration', 'view');
  assert.ok(hrmsKeys.length > 0, 'the hrms module must be grantable');
  for (const key of hrmsKeys) assert.doesNotMatch(String(key), /^hrms_/);

  // A grant naming a module that is not in the registry is still rejected
  // outright, rather than silently dropped.
  const { error } = validateGrants([{ module: 'not_a_module', submodule: 'x', actions: ['view'] }]);
  assert.ok(error, 'a grant outside the registry must be refused');
  // As is a real module with a sub-module that does not exist on it.
  assert.ok(validateGrants([{ module: 'hrms', submodule: 'nope', actions: ['view'] }]).error);
  assert.deepEqual([...compileGrants([])], []);
});

test('updateUserAccess enforces AD-4 itself, not through the schema hook', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../modules/users/user.controller.js', import.meta.url),
    'utf8',
  );
  const handler = src.slice(src.indexOf('export const updateUserAccess'));

  // It saves with validation OFF, so the model's AD-4 hook does not run here.
  assert.match(handler, /validateBeforeSave: false/);
  // Therefore the controller must check both halves itself.
  assert.match(handler, /isHrmsRoleKey/, 'must refuse a grant carrying an HRMS role');
  assert.match(handler, /denyIfRoleCombinationInvalid/, 'must re-check the account role pair');
});

// ---------------------------------------------------------------------------
// 7 - 10. The HRMS half still works, through User.roles[]
// ---------------------------------------------------------------------------

test('an HRMS role granted through User.roles[] still resolves', () => {
  const actor = buildHrmsActor({
    userId: 'u1',
    roles: ['hrms_hr_admin'],
    legacyRole: 'Management',
    employee: { id: 'e1', departmentId: 'd1', managerChain: [] },
  });

  assert.deepEqual(actor.roleKeys, ['hrms_hr_admin']);
  assert.equal(hasAnyHrmsAccess(actor), true);
  assert.equal(hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG), true);
});




// ---------------------------------------------------------------------------
// 11 + 12. The Employee invariants the merge must not disturb
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 15. The portal's own access is exactly what it was
// ---------------------------------------------------------------------------

test('every production role keeps the portal access it had, and gains no HRMS', async () => {
  /*
   * ASSERTED IN THE CUSTOMER DOMAIN, EXPLICITLY.
   *
   * These are customer-portal permissions — raising a PO, seeing every booking,
   * onboarding a customer. Since the portal separation, `resolveUserPermissions`
   * fences a user to the modules the CURRENT deployment serves, so Sales
   * correctly holds none of them while the process is serving the employee
   * domain. That is the feature, not a regression.
   *
   * The claim this test makes — "no role lost the access it had" — is therefore
   * a claim about a domain, and it names the one it means rather than inheriting
   * whichever repository happens to be running it. Without this the same file
   * passes in one repo and fails in the other for a reason that looks like a bug.
   */
  const prevPortal = process.env.PORTAL;
  process.env.PORTAL = 'customer';
  try {
  const expected = {
    Admin: '*',
    Sales: [PERMISSIONS.VIEW_ALL_BOOKINGS, PERMISSIONS.RAISE_PO, PERMISSIONS.MANAGE_CUSTOMER_USERS],
    Management: [PERMISSIONS.APPROVE_ADJUSTMENT, PERMISSIONS.VIEW_REPORTS],
    'Import Team': [PERMISSIONS.MANAGE_INVENTORY_MASTER, PERMISSIONS.POST_STOCK_IN],
    Customer: [PERMISSIONS.CREATE_ORDER, PERMISSIONS.VIEW_ORDERS],
  };

  for (const [role, keys] of Object.entries(expected)) {
    const user = { role, roles: [] };
    if (keys === '*') {
      assert.equal(hasPermission(user, '*'), true, `${role} keeps the wildcard`);
    } else {
      for (const key of keys) {
        assert.equal(hasPermission(user, key), true, `${role} must keep ${key}`);
      }
    }
    // None of them gains HRMS access by existing.
    assert.equal(
      hasAnyHrmsAccess(buildHrmsActor({ roles: user.roles, legacyRole: role })),
      false,
      `${role} must hold no HRMS access without an hrms_ role`,
    );
  }

  // Separation of duties, unchanged: Sales raises the PO it cannot then unlock.
  assert.equal(hasPermission({ role: 'Sales', roles: [] }, PERMISSIONS.OVERRIDE_PO_LOCK), false);
  } finally {
    if (prevPortal === undefined) delete process.env.PORTAL;
    else process.env.PORTAL = prevPortal;
  }
});
