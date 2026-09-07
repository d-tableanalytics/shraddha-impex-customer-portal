/**
 * Shared permission foundation.
 *
 * Covers Phase 0 verification requirements 1, 2 and 12:
 *   1.  A Customer cannot reach HRMS.
 *   2.  HRMS SELF permissions belong to HRMS roles, not to authentication.
 *   12. The HRMS foundation does not break existing customer functionality.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSIONS,
  INVENTORY_ROLES,
  permissionsFor,
  hasLegacyPermission,
  LEGACY_ROLE_PERMISSIONS,
} from '../shared/permissions/legacy.js';

import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
  HRMS_ROLES as R,
  isHrmsRoleKey,
  HRMS_ROLE_LIST,
  HRMS_MODULE_LIST,
} from '../shared/permissions/constants.js';

import {
  HRMS_PERMISSION_MATRIX,
  permissionsForHrmsRoles,
  modulesForHrmsRoles,
} from '../shared/permissions/matrix.js';

import {
  buildHrmsActor,
  hasHrmsPermission,
  canAccessHrmsModule,
  hasAnyHrmsAccess,
  ANONYMOUS_HRMS_ACTOR,
} from '../shared/permissions/has-permission.js';

import legacyMiddleware, {
  hasPermission as rbacHasPermission,
  PERMISSIONS as rbacPermissions,
  INVENTORY_ROLES as rbacInventoryRoles,
  permissionsFor as rbacPermissionsFor,
} from '../middlewares/rbac.js';

// ---------------------------------------------------------------------------
// Backward compatibility: the portal's model is untouched
// ---------------------------------------------------------------------------

test('legacy: middlewares/rbac.js still exports the original surface', () => {
  assert.equal(typeof rbacHasPermission, 'function');
  assert.equal(typeof rbacPermissionsFor, 'function');
  assert.equal(typeof legacyMiddleware.authorize, 'function');
  // The portal's vocabulary is now owned by config/permissions.js and grows
  // with the ERP, so this is a SUPERSET check rather than an equality one:
  // every key the HRMS foundation was written against must still exist and
  // still mean the same thing. A missing one is a break; a new one is not.
  for (const [name, key] of Object.entries(PERMISSIONS)) {
    assert.equal(rbacPermissions[name], key, `rbac.js must still export ${name}`);
  }
  for (const role of INVENTORY_ROLES) {
    assert.ok(rbacInventoryRoles.includes(role), `${role} must still be an inventory role`);
  }
  // The default export shape several call sites rely on.
  for (const k of ['authorize', 'hasPermission', 'permissionsFor', 'PERMISSIONS', 'INVENTORY_ROLES']) {
    assert.ok(k in legacyMiddleware, `default export is missing ${k}`);
  }
});

test('legacy: Admin keeps the wildcard and satisfies every capability', () => {
  const admin = { role: 'Admin' };
  assert.deepEqual(permissionsFor(admin), ['*']);
  for (const perm of Object.values(PERMISSIONS)) {
    assert.equal(hasLegacyPermission(admin, perm), true, `Admin should hold ${perm}`);
  }
});

test('legacy: role capabilities are unchanged', () => {
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.RAISE_PO), true);
  // Separation of duties: raising the PO locks the booking against Sales itself.
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.OVERRIDE_PO_LOCK), false);
  // Nobody both creates and approves their own stock correction.
  assert.equal(hasLegacyPermission({ role: 'Inventory Manager' }, PERMISSIONS.ADJUST_STOCK), true);
  assert.equal(hasLegacyPermission({ role: 'Inventory Manager' }, PERMISSIONS.APPROVE_ADJUSTMENT), false);
  assert.equal(hasLegacyPermission({ role: 'Management' }, PERMISSIONS.APPROVE_ADJUSTMENT), true);
  assert.equal(hasLegacyPermission({ role: 'Management' }, PERMISSIONS.ADJUST_STOCK), false);
  // Sales onboards customers only; it can never mint an Admin.
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.MANAGE_CUSTOMER_USERS), true);
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.MANAGE_USERS), false);
  // Customer holds exactly one capability.
  assert.deepEqual(LEGACY_ROLE_PERMISSIONS.Customer, [PERMISSIONS.CREATE_ORDER]);
  assert.deepEqual(INVENTORY_ROLES, ['Inventory Manager', 'Warehouse User', 'Management']);
});

test('legacy: an unknown or absent role holds nothing', () => {
  assert.deepEqual(permissionsFor(undefined), []);
  assert.deepEqual(permissionsFor({ role: 'Nonexistent' }), []);
  assert.equal(hasLegacyPermission({}, PERMISSIONS.CREATE_ORDER), false);
});

// ---------------------------------------------------------------------------
// AD-4: Customer != Employee
// ---------------------------------------------------------------------------

test('AD-4: a Customer receives no HRMS permission at all', () => {
  const actor = buildHrmsActor({
    userId: 'u1',
    roles: ['Customer'],
    legacyRole: 'Customer',
  });

  assert.deepEqual(actor.roleKeys, []);
  assert.deepEqual(actor.permissions, []);
  assert.equal(hasAnyHrmsAccess(actor), false);

  for (const module of HRMS_MODULE_LIST) {
    assert.equal(canAccessHrmsModule(actor, module), false, `Customer must not reach ${module}`);
    for (const action of Object.values(A)) {
      for (const scope of Object.values(S)) {
        assert.equal(
          hasHrmsPermission(actor, module, action, scope),
          false,
          `Customer must not hold ${module}:${action}:${scope}`,
        );
      }
    }
  }
});

test('AD-4: no portal role grants any HRMS permission', () => {
  for (const role of Object.keys(LEGACY_ROLE_PERMISSIONS)) {
    const actor = buildHrmsActor({ userId: 'u1', roles: [role], legacyRole: role });
    assert.deepEqual(actor.permissions, [], `portal role ${role} must grant no HRMS permission`);
    assert.equal(hasAnyHrmsAccess(actor), false, `portal role ${role} must have no HRMS access`);
  }
});

test("AD-4: the portal Admin wildcard does not reach HRMS", () => {
  const admin = buildHrmsActor({ userId: 'u1', roles: ['Admin'], legacyRole: 'Admin' });
  assert.equal(hasAnyHrmsAccess(admin), false);
  assert.equal(hasHrmsPermission(admin, M.PAYROLL, A.RUN, S.ORG), false);
  assert.equal(hasHrmsPermission(admin, M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG), false);
});

test('AD-4: authentication alone grants nothing - SELF needs an HRMS role', () => {
  // An authenticated user with no roles at all.
  const bare = buildHrmsActor({ userId: 'u1', roles: [] });
  assert.equal(hasHrmsPermission(bare, M.PAYROLL, A.VIEW, S.SELF), false);
  assert.equal(hasHrmsPermission(bare, M.DASHBOARD, A.VIEW, S.SELF), false);
  assert.equal(hasAnyHrmsAccess(bare), false);

  // The same user, once given the employee role, gets exactly the baseline.
  const employee = buildHrmsActor({ userId: 'u1', roles: [R.EMPLOYEE] });
  assert.equal(hasHrmsPermission(employee, M.PAYROLL, A.VIEW, S.SELF), true);
  assert.equal(hasHrmsPermission(employee, M.DASHBOARD, A.VIEW, S.SELF), true);
});

test('AD-4: the anonymous actor is inert', () => {
  assert.equal(hasAnyHrmsAccess(ANONYMOUS_HRMS_ACTOR), false);
  assert.equal(hasHrmsPermission(ANONYMOUS_HRMS_ACTOR, M.EMPLOYEES, A.VIEW, S.SELF), false);
  assert.equal(hasHrmsPermission(null, M.EMPLOYEES, A.VIEW, S.SELF), false);
  assert.equal(hasHrmsPermission(undefined, M.EMPLOYEES, A.VIEW, S.SELF), false);
});

// ---------------------------------------------------------------------------
// AD-3: multi-role
// ---------------------------------------------------------------------------

test('AD-3: portal and HRMS roles coexist on one user', () => {
  const actor = buildHrmsActor({
    userId: 'u1',
    roles: ['Sales', R.EMPLOYEE],
    legacyRole: 'Sales',
  });

  // The portal side is untouched by the HRMS actor.
  assert.equal(hasLegacyPermission({ role: 'Sales' }, PERMISSIONS.RAISE_PO), true);
  // The HRMS side sees only the HRMS role.
  assert.deepEqual(actor.roleKeys, [R.EMPLOYEE]);
  assert.equal(hasHrmsPermission(actor, M.LEAVE, A.SUBMIT, S.SELF), true);
  // ...and gains nothing from being Sales.
  assert.equal(hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.ORG), false);
});

test('AD-3: several HRMS roles union their grants', () => {
  const actor = buildHrmsActor({ userId: 'u1', roles: [R.EMPLOYEE, R.IT_ADMIN] });
  assert.equal(hasHrmsPermission(actor, M.LEAVE, A.SUBMIT, S.SELF), true); // from employee
  assert.equal(hasHrmsPermission(actor, M.ASSETS, A.ASSIGN, S.ORG), true); // from it_admin
});

test('AD-3: every HRMS role key is namespaced and recognised', () => {
  for (const key of HRMS_ROLE_LIST) {
    assert.equal(isHrmsRoleKey(key), true, `${key} should be an HRMS role key`);
    assert.ok(HRMS_PERMISSION_MATRIX[key], `${key} must appear in the matrix`);
  }
  for (const key of Object.keys(LEGACY_ROLE_PERMISSIONS)) {
    assert.equal(isHrmsRoleKey(key), false, `${key} must not look like an HRMS role key`);
  }
  // AD-5: these two are out of scope and must not exist.
  assert.equal(HRMS_ROLE_LIST.includes('hrms_project_manager'), false);
  assert.equal(HRMS_MODULE_LIST.includes('operations'), false);
  assert.equal(HRMS_MODULE_LIST.includes('projects'), false);
});

// ---------------------------------------------------------------------------
// Scope evaluation
// ---------------------------------------------------------------------------

test('scope: a wider grant satisfies a narrower requirement', () => {
  const hr = buildHrmsActor({ userId: 'u1', roles: [R.HR_ADMIN] });
  // hr_admin holds leave/approve/org.
  assert.equal(hasHrmsPermission(hr, M.LEAVE, A.APPROVE, S.ORG), true);
  assert.equal(hasHrmsPermission(hr, M.LEAVE, A.APPROVE, S.DEPARTMENT), true);
  assert.equal(hasHrmsPermission(hr, M.LEAVE, A.APPROVE, S.TEAM), true);
  assert.equal(hasHrmsPermission(hr, M.LEAVE, A.APPROVE, S.SELF), true);
});

test('scope: a narrower grant does not satisfy a wider requirement', () => {
  const mgr = buildHrmsActor({
    userId: 'u2',
    roles: [R.MANAGER],
    employee: { id: 'e2', departmentId: 'd1', managerChain: [] },
  });
  // manager holds leave/approve/team.
  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.TEAM), true);
  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.ORG), false);
  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.DEPARTMENT), false);
});

test('scope: team reach follows the resource managerChain', () => {
  const mgr = buildHrmsActor({
    userId: 'u2',
    roles: [R.MANAGER],
    employee: { id: 'mgr-1', departmentId: 'd1', managerChain: [] },
  });

  const directReport = { ownerEmployeeId: 'e9', ownerManagerChain: ['mgr-1'] };
  const skipLevel = { ownerEmployeeId: 'e8', ownerManagerChain: ['mgr-x', 'mgr-1'] };
  const stranger = { ownerEmployeeId: 'e7', ownerManagerChain: ['someone-else'] };

  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.TEAM, directReport), true);
  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.TEAM, skipLevel), true);
  assert.equal(hasHrmsPermission(mgr, M.LEAVE, A.APPROVE, S.TEAM, stranger), false);
});

test('scope: self reach matches on employee id or user id', () => {
  const emp = buildHrmsActor({
    userId: 'u3',
    roles: [R.EMPLOYEE],
    employee: { id: 'e3', departmentId: 'd1', managerChain: ['mgr-1'] },
  });

  assert.equal(hasHrmsPermission(emp, M.LEAVE, A.VIEW, S.SELF, { ownerEmployeeId: 'e3' }), true);
  assert.equal(hasHrmsPermission(emp, M.LEAVE, A.VIEW, S.SELF, { ownerUserId: 'u3' }), true);
  assert.equal(hasHrmsPermission(emp, M.LEAVE, A.VIEW, S.SELF, { ownerEmployeeId: 'other' }), false);
  // An employee cannot reach a colleague through team scope.
  assert.equal(
    hasHrmsPermission(emp, M.LEAVE, A.VIEW, S.TEAM, { ownerEmployeeId: 'other' }),
    false,
  );
});

test('scope: department reach compares department ids', () => {
  // No seeded role holds department scope, so this exercises the evaluator
  // directly with a hand-built actor.
  const actor = {
    userId: 'u4',
    employeeId: 'e4',
    departmentId: 'd1',
    managerChain: [],
    roleKeys: [R.EMPLOYEE],
    permissions: [{ module: M.EMPLOYEES, action: A.VIEW, scope: S.DEPARTMENT }],
  };
  assert.equal(
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.DEPARTMENT, { ownerDepartmentId: 'd1' }),
    true,
  );
  assert.equal(
    hasHrmsPermission(actor, M.EMPLOYEES, A.VIEW, S.DEPARTMENT, { ownerDepartmentId: 'd2' }),
    false,
  );
});

test('scope: an unknown scope or module is refused', () => {
  const hr = buildHrmsActor({ userId: 'u1', roles: [R.HR_ADMIN] });
  assert.equal(hasHrmsPermission(hr, M.LEAVE, A.APPROVE, 'galaxy'), false);
  assert.equal(hasHrmsPermission(hr, 'not-a-module', A.VIEW, S.ORG), false);
  assert.equal(hasHrmsPermission(hr, M.LEAVE, 'teleport', S.ORG), false);
});

// ---------------------------------------------------------------------------
// Separation of duties inside the HRMS matrix
// ---------------------------------------------------------------------------

test('matrix: HR admin may view payroll but never run it', () => {
  const hr = buildHrmsActor({ userId: 'u1', roles: [R.HR_ADMIN] });
  assert.equal(hasHrmsPermission(hr, M.PAYROLL, A.VIEW, S.ORG), true);
  assert.equal(hasHrmsPermission(hr, M.PAYROLL, A.RUN, S.ORG), false);

  const payroll = buildHrmsActor({ userId: 'u2', roles: [R.PAYROLL_ADMIN] });
  assert.equal(hasHrmsPermission(payroll, M.PAYROLL, A.RUN, S.ORG), true);
});

test('matrix: compensation is restricted to payroll admin and super admin', () => {
  const canSee = [R.PAYROLL_ADMIN, R.SUPER_ADMIN];
  for (const role of HRMS_ROLE_LIST) {
    const actor = buildHrmsActor({ userId: 'u1', roles: [role] });
    assert.equal(
      hasHrmsPermission(actor, M.EMPLOYEES_COMPENSATION, A.VIEW, S.ORG),
      canSee.includes(role),
      `${role} compensation visibility`,
    );
  }
});

test('matrix: helpdesk resolution is category-scoped', () => {
  const hr = buildHrmsActor({ userId: 'u1', roles: [R.HR_ADMIN] });
  const it = buildHrmsActor({ userId: 'u2', roles: [R.IT_ADMIN] });
  const pay = buildHrmsActor({ userId: 'u3', roles: [R.PAYROLL_ADMIN] });

  assert.equal(hasHrmsPermission(hr, M.HELPDESK_HR, A.RESOLVE, S.ORG), true);
  assert.equal(hasHrmsPermission(hr, M.HELPDESK_IT, A.RESOLVE, S.ORG), false);
  assert.equal(hasHrmsPermission(it, M.HELPDESK_IT, A.RESOLVE, S.ORG), true);
  assert.equal(hasHrmsPermission(it, M.HELPDESK_HR, A.RESOLVE, S.ORG), false);
  assert.equal(hasHrmsPermission(pay, M.HELPDESK_PAYROLL, A.RESOLVE, S.ORG), true);
});

test('matrix: the auditor is read-only', () => {
  const auditor = buildHrmsActor({ userId: 'u1', roles: [R.AUDITOR] });
  for (const grant of HRMS_PERMISSION_MATRIX[R.AUDITOR]) {
    assert.equal(grant.action, A.VIEW, `auditor grant ${grant.module} must be view-only`);
  }
  assert.equal(hasHrmsPermission(auditor, M.PAYROLL, A.RUN, S.ORG), false);
  assert.equal(hasHrmsPermission(auditor, M.EMPLOYEES, A.EDIT, S.ORG), false);
});

test('matrix: every grant references a real module, action and scope', () => {
  for (const [role, grants] of Object.entries(HRMS_PERMISSION_MATRIX)) {
    for (const g of grants) {
      assert.ok(HRMS_MODULE_LIST.includes(g.module), `${role}: unknown module ${g.module}`);
      assert.ok(Object.values(A).includes(g.action), `${role}: unknown action ${g.action}`);
      assert.ok(Object.values(S).includes(g.scope), `${role}: unknown scope ${g.scope}`);
    }
  }
});

test('matrix: helpers de-duplicate across roles', () => {
  // employee is a strict subset of hr_admin's baseline, so the union must not
  // repeat a single grant.
  const grants = permissionsForHrmsRoles([R.EMPLOYEE, R.HR_ADMIN]);
  const ids = grants.map((g) => `${g.module}|${g.action}|${g.scope}`);
  assert.equal(new Set(ids).size, ids.length, 'permissionsForHrmsRoles returned duplicates');

  const modules = modulesForHrmsRoles([R.EMPLOYEE]);
  assert.equal(new Set(modules).size, modules.length);
  assert.ok(modules.includes(M.DASHBOARD));

  // Unknown keys contribute nothing rather than throwing.
  assert.deepEqual(permissionsForHrmsRoles(['nope']), []);
  assert.deepEqual(permissionsForHrmsRoles(), []);
});
