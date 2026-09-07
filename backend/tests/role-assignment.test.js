/**
 * AD-4 on the write path: a Customer account cannot be given HRMS roles.
 *
 * The guard exists in three layers, and each is tested here:
 *   1. assertRolesAssignable()          - the rule itself
 *   2. the User schema pre('validate')  - backstop for .save()
 *   3. the user controller              - the HTTP write paths
 *
 * Layer 2 needs the Mongoose schema but NOT a database connection: validation
 * runs entirely in memory on a document that is never saved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assertRolesAssignable,
  canAssignRoles,
  assignableHrmsRolesFor,
  hasHrmsRole,
  isAssignableRoleKey,
  RoleAssignmentError,
  CUSTOMER_ROLE,
} from '../shared/permissions/assignment.js';
import { HRMS_ROLES as R, HRMS_ROLE_LIST } from '../shared/permissions/constants.js';
import User from '../models/User.js';

// ---------------------------------------------------------------------------
// Layer 1: the rule
// ---------------------------------------------------------------------------

test('AD-4: a Customer cannot hold any HRMS role', () => {
  for (const role of HRMS_ROLE_LIST) {
    assert.throws(
      () => assertRolesAssignable(CUSTOMER_ROLE, [role]),
      (err) => err instanceof RoleAssignmentError && err.code === 'CUSTOMER_CANNOT_HOLD_HRMS_ROLE',
      `Customer must not be assignable ${role}`,
    );
  }
  assert.equal(canAssignRoles(CUSTOMER_ROLE, [R.EMPLOYEE]), false);
});

test('AD-4: a Customer with no HRMS roles is fine', () => {
  assert.equal(assertRolesAssignable(CUSTOMER_ROLE, []), true);
  assert.equal(assertRolesAssignable(CUSTOMER_ROLE), true);
  assert.equal(canAssignRoles(CUSTOMER_ROLE, []), true);
});

test('AD-3: any non-Customer portal role may hold HRMS roles', () => {
  for (const role of ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management']) {
    assert.equal(canAssignRoles(role, [R.EMPLOYEE]), true, `${role} should allow hrms_employee`);
    assert.equal(canAssignRoles(role, [R.EMPLOYEE, R.MANAGER]), true);
  }
});

test('unknown role keys are refused', () => {
  assert.throws(
    () => assertRolesAssignable('Admin', ['not_a_role']),
    (err) => err.code === 'ROLE_UNKNOWN',
  );
  assert.equal(isAssignableRoleKey('Admin'), true);
  assert.equal(isAssignableRoleKey(R.HR_ADMIN), true);
  assert.equal(isAssignableRoleKey('hrms_project_manager'), false, 'AD-5: out of scope');
  assert.equal(isAssignableRoleKey('operations'), false);
});

test('assignableHrmsRolesFor offers nothing to a Customer', () => {
  assert.deepEqual(assignableHrmsRolesFor(CUSTOMER_ROLE), []);
  assert.deepEqual(assignableHrmsRolesFor('Admin'), HRMS_ROLE_LIST);
});

test('hasHrmsRole recognises only hrms_ keys', () => {
  assert.equal(hasHrmsRole({ roles: [R.EMPLOYEE] }), true);
  assert.equal(hasHrmsRole({ roles: ['Admin'] }), false);
  assert.equal(hasHrmsRole({ roles: [] }), false);
  assert.equal(hasHrmsRole({}), false);
  assert.equal(hasHrmsRole(null), false);
});

// ---------------------------------------------------------------------------
// Layer 2: the schema backstop (no database needed)
// ---------------------------------------------------------------------------

// NOTE: doc.validate() not doc.validateSync(). The cross-field AD-4 rule lives
// in a pre('validate') hook, and validateSync() runs only synchronous path
// validators - it skips hooks entirely. Using the sync form here would have
// made this test pass vacuously.
test('schema: a Customer document with an HRMS role fails validation', async () => {
  const doc = new User({
    email: 'buyer@example.com',
    password: 'x',
    role: 'Customer',
    roles: [R.HR_ADMIN],
  });
  await assert.rejects(
    () => doc.validate(),
    (err) => /cannot hold HRMS roles/i.test(String(err.message)),
  );
});

test('schema: a non-Customer document with an HRMS role validates', async () => {
  const doc = new User({
    email: 'staff@example.com',
    password: 'x',
    role: 'Sales',
    roles: [R.EMPLOYEE],
  });
  await doc.validate(); // resolves
});

test('schema: an unknown role key fails validation', async () => {
  const doc = new User({
    email: 'staff2@example.com',
    password: 'x',
    role: 'Sales',
    roles: ['hrms_nonsense'],
  });
  // Caught by the path validator, which DOES run synchronously.
  assert.ok(doc.validateSync(), 'unknown key must fail the path validator');
  await assert.rejects(() => doc.validate());
});

test('schema: roles defaults to empty, so every existing account has no HRMS access', async () => {
  const doc = new User({ email: 'legacy@example.com', password: 'x' });
  assert.deepEqual([...doc.roles], []);
  assert.equal(doc.role, 'Customer', 'the existing default is unchanged');
  await doc.validate();
});

test('schema: the existing portal fields are untouched', () => {
  const path = User.schema.path('role');
  /**
   * `role` was a fixed enum; it is a VALIDATOR now, because a Super Admin can
   * create roles and an enum cannot grow at runtime. What must not change is
   * that it is still a closed set - every built-in name still validates, and a
   * name nobody defined still does not.
   */
  assert.equal(path.enumValues.length, 0, 'no longer an enum - see isAssignableRoleName');

  // `validateSync` reports rather than throws, and reports every field at once,
  // so the question asked is specifically "did `role` fail".
  const roleError = (role) =>
    new User({ email: 'x@y.z', password: 'x'.repeat(20), user: 'X', role }).validateSync()?.errors?.role;

  for (const name of ['Admin', 'Sales', 'Inventory Manager', 'Warehouse User', 'Management', 'Customer']) {
    assert.equal(roleError(name), undefined, `${name} must still be assignable`);
  }
  assert.ok(roleError('Not A Real Role'), 'a role nobody defined must still be refused');
  // Fields the portal depends on still exist.
  for (const f of ['email', 'password', 'company', 'brandAccess', 'status', 'customerCategory']) {
    assert.ok(User.schema.path(f) || User.schema.nested[f], `${f} must still exist`);
  }
});

// ---------------------------------------------------------------------------
// Layer 3: the HTTP write paths are guarded
// ---------------------------------------------------------------------------

test('the user controller guards every path that can change a portal role', async () => {
  const src = await readFile(new URL('../modules/users/user.controller.js', import.meta.url), 'utf8');
  assert.match(src, /denyIfRoleCombinationInvalid/, 'the guard helper must exist');
  // createUser, updateUser and updateUserRole each call it.
  const calls = src.match(/denyIfRoleCombinationInvalid\(res,/g) ?? [];
  assert.ok(
    calls.length >= 3,
    `expected the guard on createUser, updateUser and updateUserRole; found ${calls.length}`,
  );
  // The rule moved behind hrmsRoleGuard, which asks the LIVE role model whether
  // the portal role is portal-only instead of comparing it to 'Customer'. The
  // controller must use that, not a local copy and not the narrower helper.
  assert.match(
    src,
    /import \{ assertHrmsRolesAssignable \} from '\.\.\/\.\.\/utils\/hrmsRoleGuard\.js'/,
    'the controller must use the widened shared rule',
  );
  assert.doesNotMatch(
    src,
    /assertRolesAssignable\(/,
    'the narrow Customer-only rule must not be called directly here',
  );
});
