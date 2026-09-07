/**
 * Proves the new role model did not take anything away.
 *
 *   node scripts/verify-rbac.js
 *
 * Runs with NO database. That is the point: the compiled-in baseline is what
 * guarantees requirement 7, so it has to hold before Mongo is even reachable.
 * Everything checked here is true of a cold process with an empty roles
 * collection.
 *
 * The snapshot below is the role map exactly as it stood in
 * backend/middlewares/rbac.js at commit 318a9d2, immediately before the RBAC
 * work began. It is duplicated here on purpose rather than imported: importing
 * the current map would make this test assert that the code equals itself.
 * A frozen copy is the only thing that can catch a permission going missing.
 */

import assert from 'node:assert';
import {
  PERMISSIONS,
  BASELINE_ROLE_PERMISSIONS,
  baselineFor,
} from '../config/permissions.js';
import {
  MODULES,
  compileGrants,
  grantsFromPermissions,
  availableActions,
  allRegistryKeys,
} from '../config/moduleRegistry.js';
import { resolveRolePermissions, resolveUserPermissions, can, menuFor } from '../utils/roleResolver.js';

// ── The frozen "before" picture ────────────────────────────────────────────
const BEFORE = {
  Admin: ['*'],
  Sales: [
    'view_all_bookings', 'manage_customer_users', 'edit_booking_pre_po',
    'raise_po', 'view_reports', 'view_inventory',
  ],
  'Inventory Manager': [
    'view_inventory', 'view_stock_ledger', 'manage_inventory_master',
    'export_inventory', 'post_stock_in', 'post_stock_out', 'adjust_stock',
    'perform_count', 'approve_count', 'transfer_stock', 'view_reports',
  ],
  'Warehouse User': [
    'view_inventory', 'view_stock_ledger', 'export_inventory',
    'post_stock_in', 'perform_count', 'transfer_stock',
  ],
  Management: [
    'view_inventory', 'view_stock_ledger', 'export_inventory',
    'approve_adjustment', 'approve_count', 'view_reports',
  ],
  'Import Team': [
    'view_inventory', 'manage_inventory_master', 'export_inventory',
    'view_stock_ledger', 'post_stock_in',
  ],
  Customer: ['create_order'],
};

let passed = 0;
let failed = 0;

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
};

const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

// ───────────────────────────────────────────────────────────────────────────
section('1. Every permission each role held before, it still holds');

for (const [role, before] of Object.entries(BEFORE)) {
  const now = resolveRolePermissions(role);
  const lost = before.filter((p) => !(now.includes('*') || now.includes(p)));
  check(
    `${role} kept all ${before.length} of its permissions`,
    lost.length === 0,
    lost.length ? `lost: ${lost.join(', ')}` : '',
  );
}

// ───────────────────────────────────────────────────────────────────────────
section('2. Nothing gained a permission it did not have (beyond the named portal keys)');

// The only additions are the Customer Portal keys, which name access these
// roles already had through an unpermissioned sidebar. Any OTHER new key on a
// role would be a privilege escalation introduced by this change.
const PORTAL_ADDITIONS = new Set([
  PERMISSIONS.VIEW_DASHBOARD, PERMISSIONS.VIEW_CATALOGUE, PERMISSIONS.VIEW_PROFILE,
  PERMISSIONS.EDIT_PROFILE, PERMISSIONS.VIEW_HELP, PERMISSIONS.VIEW_ORDERS,
]);

/**
 * Capabilities a role was DELIBERATELY given after this snapshot was taken.
 *
 * Kept apart from PORTAL_ADDITIONS, which name access that already existed
 * without a key behind it. These are genuinely new powers, listed one by one
 * with the role that has them, so the check above keeps its teeth: anything a
 * role picks up that is not on either list still fails, which is the escalation
 * this section exists to catch.
 *
 *   view_pricing (Sales) — the customer pricing feature. Sales quotes the
 *   customer, so Sales sees the price schedule; no other non-wildcard role
 *   holds it, which the pricing suite asserts directly.
 */
const DELIBERATE_ADDITIONS = {
  Sales: new Set([PERMISSIONS.VIEW_PRICING]),
};

for (const [role, before] of Object.entries(BEFORE)) {
  if (before.includes('*')) continue;
  const now = resolveRolePermissions(role);
  const allowed = DELIBERATE_ADDITIONS[role] || new Set();
  const gained = now.filter((p) =>
    !before.includes(p) && !PORTAL_ADDITIONS.has(p) && !allowed.has(p));
  check(
    `${role} gained nothing unexpected`,
    gained.length === 0,
    gained.length ? `unexpectedly gained: ${gained.join(', ')}` : '',
  );
}

// VIEW_ORDERS is booking history. It must NOT reach the internal stock roles,
// which have never been able to see bookings.
for (const role of ['Inventory Manager', 'Warehouse User', 'Management', 'Import Team']) {
  const now = resolveRolePermissions(role);
  check(
    `${role} still cannot see bookings`,
    !now.includes(PERMISSIONS.VIEW_ORDERS) && !now.includes(PERMISSIONS.VIEW_ALL_BOOKINGS),
  );
}

// ───────────────────────────────────────────────────────────────────────────
section('3. Migrating a role through the matrix never over-grants');

// grantsFromPermissions() writes the seeded matrix; compileGrants() reads it
// back. The round trip must be a subset - a matrix that resolves to MORE than
// the role started with would hand somebody access during a migration.
for (const [role, before] of Object.entries(BEFORE)) {
  if (before.includes('*')) continue;
  const baseline = baselineFor(role);
  const roundTripped = [...compileGrants(grantsFromPermissions(baseline))];
  const extra = roundTripped.filter((p) => !baseline.includes(p));
  check(
    `${role}: matrix round-trip grants nothing extra`,
    extra.length === 0,
    extra.length ? `would have added: ${extra.join(', ')}` : '',
  );
}

// ───────────────────────────────────────────────────────────────────────────
section('4. Super Admin has everything, permanently');

for (const role of ['Super Admin', 'Admin']) {
  const now = resolveRolePermissions(role);
  check(`${role} resolves to the wildcard`, now.includes('*'));
  check(
    `${role} satisfies every permission in the vocabulary`,
    Object.values(PERMISSIONS).every((p) => now.includes('*') || now.includes(p)),
  );
  check(
    `${role} can take every action in every module`,
    MODULES.every((m) =>
      m.submodules.every((s) =>
        availableActions(s).every((a) => can({ role }, m.key, s.key, a)),
      ),
    ),
  );
}

// ───────────────────────────────────────────────────────────────────────────
section('5. Customers reach the Customer Portal and nothing else');

const customer = resolveRolePermissions('Customer');
const portalKeys = new Set();
for (const sub of MODULES.find((m) => m.key === 'customer_portal').submodules) {
  for (const a of availableActions(sub)) for (const k of sub.actions[a]) portalKeys.add(k);
}

check(
  'every permission a Customer holds belongs to the Customer Portal',
  customer.every((p) => portalKeys.has(p)),
  customer.filter((p) => !portalKeys.has(p)).join(', '),
);

for (const [mod, sub, action] of [
  ['inventory', 'master', 'view'],
  ['inventory', 'master', 'edit'],
  ['inventory', 'ledger', 'view'],
  ['sales', 'bookings', 'view'],
  ['administration', 'users', 'view'],
  ['administration', 'roles', 'edit'],
]) {
  check(`Customer refused ${mod}.${sub}:${action}`, !can({ role: 'Customer' }, mod, sub, action));
}

check(
  'a Customer still books, and still reads their own bookings',
  can({ role: 'Customer' }, 'customer_portal', 'create_booking', 'create')
  && can({ role: 'Customer' }, 'customer_portal', 'booking_history', 'view'),
);

// The fence is a CEILING, not a default. A per-user grant pointing outside the
// portal is refused even though extraGrants is otherwise additive.
//
// Asserted with NO database on purpose. The Role document carries a portalOnly
// flag, but PORTAL_ONLY_ROLES in config/permissions.js carries the same fact
// compiled in - because a ceiling that only exists while a query succeeds is
// not a ceiling. This check failed the first time it was run, which is how that
// hole was found.
const smuggled = resolveUserPermissions({
  role: 'Customer',
  extraGrants: [{ module: 'inventory', submodule: 'master', actions: ['view', 'edit'] }],
});
check(
  'a Customer given inventory access by mistake still holds none',
  // Without a DB the baseline is already portal-only, so the grant is the only
  // way anything could leak in; with a DB, portalOnly filters it out.
  smuggled.every((p) => portalKeys.has(p)),
  smuggled.filter((p) => !portalKeys.has(p)).join(', '),
);

// ───────────────────────────────────────────────────────────────────────────
section('6. Separation of duties survived');

check('Sales raises a PO', can({ role: 'Sales' }, 'sales', 'bookings', 'approve'));
check('Sales cannot override the PO lock it creates',
  !can({ role: 'Sales' }, 'sales', 'bookings', 'delete'));
check('Inventory Manager creates adjustments',
  can({ role: 'Inventory Manager' }, 'inventory', 'adjustments', 'create'));
check('Inventory Manager cannot approve its own adjustments',
  !can({ role: 'Inventory Manager' }, 'inventory', 'adjustments', 'approve'));
check('Management approves adjustments',
  can({ role: 'Management' }, 'inventory', 'adjustments', 'approve'));
check('Management cannot create adjustments',
  !can({ role: 'Management' }, 'inventory', 'adjustments', 'create'));
check('Box numbers stay with Super Admin alone',
  ['Sales', 'Inventory Manager', 'Warehouse User', 'Management', 'Import Team', 'Customer']
    .every((r) => !can({ role: r }, 'inventory', 'box_numbers', 'edit')));
check('Sales cannot manage staff accounts',
  !resolveRolePermissions('Sales').includes(PERMISSIONS.MANAGE_USERS));
check('Sales can still manage customer accounts',
  resolveRolePermissions('Sales').includes(PERMISSIONS.MANAGE_CUSTOMER_USERS));
check('Import Team holds no ordering permission',
  !resolveRolePermissions('Import Team').includes(PERMISSIONS.CREATE_ORDER));

// ───────────────────────────────────────────────────────────────────────────
section('7. The registry is coherent');

const registryKeys = new Set(allRegistryKeys());
const vocabulary = new Set(Object.values(PERMISSIONS));

const unknown = [...registryKeys].filter((k) => !vocabulary.has(k));
check('every key the matrix can grant is a real permission', unknown.length === 0,
  unknown.join(', '));

// A permission with no cell cannot be granted or withheld from the admin
// screen. MANAGE_INVENTORY is the known, deliberate exception: it is the dead
// legacy umbrella, superseded by the granular inventory set and enforced
// nowhere.
const EXPECTED_UNMAPPED = new Set([PERMISSIONS.MANAGE_INVENTORY]);
const unmapped = [...vocabulary].filter((k) => !registryKeys.has(k) && !EXPECTED_UNMAPPED.has(k));
check('every live permission has a cell in the matrix', unmapped.length === 0,
  unmapped.length ? `unreachable from the admin screen: ${unmapped.join(', ')}` : '');

const dupes = [];
const seen = new Set();
for (const m of MODULES) {
  for (const s of m.submodules) {
    const id = `${m.key}.${s.key}`;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
}
check('no duplicate module.submodule keys', dupes.length === 0, dupes.join(', '));

check('every sub-module offers at least one action',
  MODULES.every((m) => m.submodules.every((s) => availableActions(s).length > 0)));

// ───────────────────────────────────────────────────────────────────────────
section('8. The sidebar a role gets matches the access it has');

for (const role of Object.keys(BEFORE)) {
  const menu = menuFor({ role });
  const bad = [];
  for (const mod of menu) {
    for (const item of mod.items) {
      if (!item.path) bad.push(`${mod.key}.${item.key} has no path`);
    }
  }
  check(`${role}: every menu entry is a real destination`, bad.length === 0, bad.join('; '));
}

const customerMenu = menuFor({ role: 'Customer' });
check('a Customer sees exactly one module, the Customer Portal',
  customerMenu.length === 1 && customerMenu[0].key === 'customer_portal',
  customerMenu.map((m) => m.key).join(', '));

// Every module with at least one VISIBLE screen. A sub-module that is
// capability-only (path: null) or not yet advertised (hidden) contributes no
// menu entry, so a module made up entirely of those correctly does not appear -
// which is the case for Reports while its screen is still a stub.
const withVisibleScreens = MODULES.filter((m) =>
  m.submodules.some((s) => s.path && !s.hidden));

const adminMenu = menuFor({ role: 'Admin' });
check('a Super Admin sees every module that has visible screens',
  adminMenu.length === withVisibleScreens.length,
  `saw ${adminMenu.length} of ${withVisibleScreens.length}: ${adminMenu.map((m) => m.key).join(', ')}`);

check('no menu entry points at a hidden or capability-only sub-module',
  menuFor({ role: 'Admin' }).every((mod) => {
    const registered = MODULES.find((m) => m.key === mod.key);
    return mod.items.every((item) => {
      const sub = registered.submodules.find((s) => s.key === item.key);
      return sub && sub.path && !sub.hidden;
    });
  }));

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

assert.strictEqual(failed, 0, `${failed} RBAC check(s) failed`);
