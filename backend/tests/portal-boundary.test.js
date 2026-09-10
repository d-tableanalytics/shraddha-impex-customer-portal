/**
 * The domain boundary between the Customer Portal and the Employee Portal.
 *
 * One database, one `users` collection, one `roles` collection — and two
 * domains that must show the same account different things. These tests are the
 * guard against the boundary quietly dissolving, which it would do silently:
 * a module that leaks into the wrong domain looks like a working feature.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODULES,
  PORTALS,
  PORTAL_LIST,
  portalsOf,
  servesPortal,
  getSubmodule,
} from '../config/moduleRegistry.js';
import { currentPortal, isCurrentPortal } from '../config/portal.js';
import { menuFor, resolveUserPermissions } from '../utils/roleResolver.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const withPortal = (portal, fn) => {
  const prev = process.env.PORTAL;
  try {
    process.env.PORTAL = portal;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PORTAL;
    else process.env.PORTAL = prev;
  }
};

// ===========================================================================
// The registry is the single source of truth
// ===========================================================================

describe('module registry portal tags', () => {
  test('every module declares which portals serve it', () => {
    for (const mod of MODULES) {
      assert.ok(
        Array.isArray(mod.portals) && mod.portals.length,
        `module "${mod.key}" has no portals tag — it would default to EVERY portal, `
          + 'which is right for a genuinely shared module but must be a decision, not an omission',
      );
      for (const p of mod.portals) {
        assert.ok(PORTAL_LIST.includes(p), `module "${mod.key}" names unknown portal "${p}"`);
      }
    }
  });

  test('the customer domain owns the customer-facing modules and not HRMS', () => {
    const served = MODULES.filter((m) => servesPortal(m, PORTALS.CUSTOMER)).map((m) => m.key);
    for (const key of ['customer_portal', 'sales', 'inventory', 'reports']) {
      assert.ok(served.includes(key), `${key} must be served by the customer domain`);
    }
    assert.ok(!served.includes('hrms'), 'HRMS must not be served by the customer domain');
  });

  test('the employee domain owns HRMS and not the sales or inventory desks', () => {
    const served = MODULES.filter((m) => servesPortal(m, PORTALS.EMPLOYEE)).map((m) => m.key);
    assert.ok(served.includes('hrms'));
    for (const key of ['sales', 'inventory', 'customer_portal']) {
      assert.ok(!served.includes(key), `${key} must not be served by the employee domain`);
    }
  });

  test('an untagged entry defaults to every portal, and that default is documented', () => {
    // The permissive default is load-bearing: it means a new module cannot be
    // accidentally hidden. The test above is what stops it being used by
    // accident on a module that DOES have a boundary.
    assert.deepEqual(portalsOf({}), PORTAL_LIST);
    assert.deepEqual(portalsOf({ portals: [] }), PORTAL_LIST);
    assert.deepEqual(portalsOf({ portals: [PORTALS.EMPLOYEE] }), [PORTALS.EMPLOYEE]);
  });
});

// ===========================================================================
// Separate user management — the split you cannot get from one screen
// ===========================================================================

describe('customer vs internal user management', () => {
  test('they are two sub-modules, at two paths, in two domains', () => {
    const customers = getSubmodule('administration', 'customers');
    const users = getSubmodule('administration', 'users');
    assert.ok(customers, 'Customer Management must exist as its own sub-module');
    assert.ok(users, 'Internal User Management must exist as its own sub-module');

    assert.notEqual(
      customers.submodule.path,
      users.submodule.path,
      'two workflows sharing one route is the fusion this split exists to undo',
    );

    // Customers are a customer-domain concern.
    assert.deepEqual(customers.submodule.portals, [PORTALS.CUSTOMER]);
    // Staff work in BOTH domains, so both can create them.
    assert.deepEqual(users.submodule.portals, [PORTALS.CUSTOMER, PORTALS.EMPLOYEE]);
  });

  test('creating a customer never requires the permission that can create an admin', () => {
    const customers = getSubmodule('administration', 'customers').submodule;
    const users = getSubmodule('administration', 'users').submodule;

    // Sales holds manage_customer_users and must reach Customer Management.
    assert.ok(customers.actions.create.includes('manage_customer_users'));
    // ...and must NOT reach Internal User Management, which is the escalation
    // path: a salesperson who could create staff could create an Admin.
    assert.ok(!users.actions.create.includes('manage_customer_users'));
    assert.deepEqual(users.actions.create, ['manage_users']);
  });

  test('the role matrix is editable in exactly one domain', () => {
    const roles = getSubmodule('administration', 'roles').submodule;
    assert.deepEqual(
      roles.portals,
      [PORTALS.EMPLOYEE],
      'two editors of one Role.grants means one can strip what the other wrote',
    );
  });
});

// ===========================================================================
// The menu, per domain — the same account, two different navigations
// ===========================================================================

describe('menu is domain-scoped', () => {
  const superAdmin = { role: 'Super Admin', roles: [], extraGrants: [] };

  test('a Super Admin sees no HRMS in the customer domain', () => {
    withPortal(PORTALS.CUSTOMER, () => {
      const keys = menuFor(superAdmin).map((m) => m.key);
      assert.ok(!keys.includes('hrms'), 'the most privileged account must still be domain-scoped');
      assert.ok(keys.includes('inventory'));
    });
  });

  test('the same Super Admin sees no customer desks in the employee domain', () => {
    withPortal(PORTALS.EMPLOYEE, () => {
      const keys = menuFor(superAdmin).map((m) => m.key);
      for (const gone of ['sales', 'inventory', 'customer_portal', 'reports']) {
        assert.ok(!keys.includes(gone), `${gone} must not appear in the employee domain`);
      }
    });
  });

  /**
   * The `hrms` module contributes NO menu entries, in either domain, and that is
   * correct rather than a gap.
   *
   * Every one of its sub-modules carries `path: null` — they are ENTRY GRANTS
   * (`access_hrms`, `manage_hrms_payroll`, …) that the Employee Portal's own
   * navigation reads to decide what to draw. Giving them paths would put a
   * second, competing set of HRMS links in the sidebar, which is exactly what
   * the registry comment on that module warns against.
   *
   * Asserted so that a future reader who notices "HRMS is missing from the menu"
   * finds this test before they add paths to fix it.
   */
  test('the HRMS module is grant-only and contributes no navigation', () => {
    const hrms = MODULES.find((m) => m.key === 'hrms');
    assert.ok(hrms.submodules.every((s) => s.path === null),
      'HRMS registry cells grant entry; the Employee Portal draws its own nav');

    for (const portal of PORTAL_LIST) {
      withPortal(portal, () => {
        assert.ok(!menuFor(superAdmin).map((m) => m.key).includes('hrms'));
      });
    }
  });

  test('Roles & Permissions appears only in the employee domain', () => {
    const pathsIn = (portal) =>
      withPortal(portal, () => menuFor(superAdmin).flatMap((m) => m.items.map((i) => i.path)));

    assert.ok(!pathsIn(PORTALS.CUSTOMER).includes('/admin/permissions'));
    assert.ok(pathsIn(PORTALS.EMPLOYEE).includes('/admin/permissions'));
  });

  test('Customer Management appears only in the customer domain', () => {
    const pathsIn = (portal) =>
      withPortal(portal, () => menuFor(superAdmin).flatMap((m) => m.items.map((i) => i.path)));

    assert.ok(pathsIn(PORTALS.CUSTOMER).includes('/admin/customers'));
    assert.ok(!pathsIn(PORTALS.EMPLOYEE).includes('/admin/customers'));
  });
});

// ===========================================================================
// Resolved permissions are fenced too — the menu is convenience, this is not
// ===========================================================================

describe('permissions are domain-scoped', () => {
  test('an HR account holds no HRMS entry key while in the customer domain', () => {
    // HR's baseline is ADMINISTER_HRMS. In the employee domain it resolves; in
    // the customer domain it must not, or `authorize('administer_hrms')` on a
    // mis-mounted route would pass.
    const hr = { role: 'HR', roles: [], extraGrants: [] };
    const inEmployee = withPortal(PORTALS.EMPLOYEE, () => resolveUserPermissions(hr));
    const inCustomer = withPortal(PORTALS.CUSTOMER, () => resolveUserPermissions(hr));

    assert.ok(inEmployee.includes('administer_hrms'));
    assert.ok(!inCustomer.includes('administer_hrms'));
  });

  test('a Sales account keeps its booking permissions in the customer domain', () => {
    const sales = { role: 'Sales', roles: [], extraGrants: [] };
    const perms = withPortal(PORTALS.CUSTOMER, () => resolveUserPermissions(sales));
    for (const key of ['raise_po', 'view_all_bookings', 'manage_customer_users']) {
      assert.ok(perms.includes(key), `Sales must keep ${key} — the fence must not cost real access`);
    }
  });

  test('a Sales account loses those same permissions in the employee domain', () => {
    const sales = { role: 'Sales', roles: [], extraGrants: [] };
    const perms = withPortal(PORTALS.EMPLOYEE, () => resolveUserPermissions(sales));
    assert.ok(!perms.includes('raise_po'));
    assert.ok(!perms.includes('view_all_bookings'));
  });
});

// ===========================================================================
// The deployment's own identity
// ===========================================================================

describe('portal identity', () => {
  test('this repository is the customer portal by default', () => {
    const prev = process.env.PORTAL;
    try {
      delete process.env.PORTAL;
      assert.equal(currentPortal(), PORTALS.CUSTOMER);
      assert.equal(isCurrentPortal(PORTALS.CUSTOMER), true);
    } finally {
      if (prev !== undefined) process.env.PORTAL = prev;
    }
  });

  test('an unrecognised PORTAL refuses to start rather than serving everything', () => {
    withPortal('customers', () => {
      // A typo must not resolve to "no tag matched -> serve all".
      assert.throws(() => currentPortal(), /not a known portal/);
    });
  });
});

// ===========================================================================
// HRMS is gone from this repository, and must stay gone
// ===========================================================================

describe('HRMS has left the customer portal', () => {
  const listFiles = async (dir) => {
    const out = [];
    const walk = async (d) => {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (['node_modules', '.git', 'uploads', 'backups', 'dist'].includes(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.js')) out.push(full);
      }
    };
    await walk(dir);
    return out;
  };

  test('no HRMS source tree remains', async () => {
    for (const gone of ['modules/hrms', 'models/hrms', 'utils/hrms', 'scripts/hrms',
                        'middlewares/hrmsAuth.js', 'utils/hrmsAccessBridge.js']) {
      const files = await listFiles(path.join(ROOT, gone));
      assert.equal(files.length, 0, `${gone} must not exist in this repository`);
    }
  });

  test('nothing imports a deleted HRMS path', async () => {
    const files = (await listFiles(ROOT)).filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      assert.doesNotMatch(
        src,
        /from '[^']*\/(modules|models)\/hrms\//,
        `${path.relative(ROOT, file)} imports a deleted HRMS path`,
      );
    }
  });

  test('the app serves no /api/v1/hrms route', async () => {
    const app = await readFile(path.join(ROOT, 'app.js'), 'utf8');
    assert.doesNotMatch(app, /app\.use\('\/api\/v1\/hrms'/);
  });

  /*
   * THE FILES THAT LOOK LIKE HRMS AND MUST STAY.
   *
   * This backend still writes the SHARED users collection, and those documents
   * carry `roles[]` — HRMS role keys. Without this guard chain, this repo could
   * put an `hrms_*` key on a customer account and the Employee Portal would
   * honour it. A cleanup that deletes "the HRMS-looking files" would remove the
   * fence and leave no sign it had gone.
   */
  test('the AD-4 fence survives, because this repo still writes User.roles[]', async () => {
    const guard = await readFile(path.join(ROOT, 'utils/hrmsRoleGuard.js'), 'utf8');
    assert.match(guard, /assertRolesAssignable/);

    const user = await readFile(path.join(ROOT, 'models/User.js'), 'utf8');
    assert.match(user, /assertHrmsRolesAssignable/, 'the schema hook must still call the fence');

    const users = await readFile(path.join(ROOT, 'modules/users/user.controller.js'), 'utf8');
    assert.match(users, /assertHrmsRolesAssignable|denyIfRoleCombinationInvalid/);
  });

  test('the HRMS permission vocabulary stays, because the shared roles collection uses it', async () => {
    const perms = await readFile(path.join(ROOT, 'config/permissions.js'), 'utf8');
    for (const key of ['access_hrms', 'administer_hrms', 'manage_hrms_payroll']) {
      assert.match(perms, new RegExp(key), `${key} must stay — a Role document may hold it`);
    }
    // And the registry must keep the cells, or validateGrants() rejects a role
    // that carries them with "Unknown module or sub-module: hrms.…".
    const reg = await readFile(path.join(ROOT, 'config/moduleRegistry.js'), 'utf8');
    assert.match(reg, /key: 'hrms'/);
  });
});

// ===========================================================================
// The permission matrix is domain-scoped — WITHOUT losing the other domain
// ===========================================================================

describe('permission matrix scoping', () => {
  test('the employee domain matrix offers HRMS and Administration, not the sales desk', async () => {
    const { registryForClient } = await import('../config/moduleRegistry.js');
    const keys = registryForClient(PORTALS.EMPLOYEE).map((m) => m.key);

    assert.ok(keys.includes('hrms'), 'HRMS is what this domain grants');
    assert.ok(keys.includes('administration'));
    for (const gone of ['customer_portal', 'sales', 'inventory', 'reports']) {
      assert.ok(!keys.includes(gone), `${gone} is not the employee domain's to grant`);
    }
  });

  test('the customer domain matrix is the mirror image', async () => {
    const { registryForClient } = await import('../config/moduleRegistry.js');
    const keys = registryForClient(PORTALS.CUSTOMER).map((m) => m.key);

    assert.ok(!keys.includes('hrms'));
    for (const kept of ['customer_portal', 'sales', 'inventory']) {
      assert.ok(keys.includes(kept));
    }
  });

  test('sub-modules narrow independently of their parent', async () => {
    const { registryForClient } = await import('../config/moduleRegistry.js');
    const subKeys = (portal) =>
      (registryForClient(portal).find((m) => m.key === 'administration')?.submodules ?? [])
        .map((s) => s.key);

    // Administration is served by both, but its children are not.
    assert.ok(subKeys(PORTALS.EMPLOYEE).includes('roles'));
    assert.ok(!subKeys(PORTALS.EMPLOYEE).includes('customers'));
    assert.ok(subKeys(PORTALS.CUSTOMER).includes('customers'));
    assert.ok(!subKeys(PORTALS.CUSTOMER).includes('roles'));
  });

  test('asking for no portal still returns the whole vocabulary', async () => {
    const { registryForClient, MODULES: ALL } = await import('../config/moduleRegistry.js');
    assert.equal(registryForClient().length, ALL.length);
    assert.equal(registryForClient(null).length, ALL.length);
  });

  /**
   * ⚠ THE ONE THAT WOULD BE SILENT DATA LOSS.
   *
   * Hiding a module from the matrix must not delete it from roles that hold it.
   * The screen seeds its draft from the role's STORED grants — keyed
   * `module.submodule`, built without the registry — and sends the whole map
   * back, so a cell it never rendered round-trips untouched.
   *
   * That only holds because `validateGrants` checks the FULL module list rather
   * than the portal-scoped one. Filter the validator too and every save of a
   * role holding another domain's grants becomes a 400 — or, worse, the cells
   * are dropped and nobody sees an error.
   *
   * This test simulates the exact round trip the UI performs.
   */
  test('a hidden cell survives a save made from the other domain', async () => {
    const { validateGrants } = await import('../config/moduleRegistry.js');

    // A role holding BOTH domains' grants, as a real HR/Admin role does.
    const stored = [
      { module: 'hrms', submodule: 'people', actions: ['view'] },
      { module: 'sales', submodule: 'bookings', actions: ['view', 'edit'] },
      { module: 'customer_portal', submodule: 'dashboard', actions: ['view'] },
    ];

    // grantsToMap -> (admin edits only the HRMS cell) -> mapToGrants
    const draft = new Map(stored.map((g) => [`${g.module}.${g.submodule}`, new Set(g.actions)]));
    draft.set('hrms.payroll', new Set(['view']));           // the one visible edit
    const sentBack = [...draft.entries()]
      .filter(([, a]) => a.size > 0)
      .map(([id, actions]) => {
        const [module, submodule] = id.split('.');
        return { module, submodule, actions: [...actions] };
      });

    const { grants: clean, error } = validateGrants(sentBack);
    assert.equal(error, undefined, `the other domain's cells must not be rejected: ${error}`);

    const back = new Set(clean.map((g) => `${g.module}.${g.submodule}`));
    assert.ok(back.has('sales.bookings'), 'a hidden sales grant must survive the save');
    assert.ok(back.has('customer_portal.dashboard'), 'a hidden customer grant must survive');
    assert.ok(back.has('hrms.payroll'), 'and the visible edit must be applied');
  });
});
