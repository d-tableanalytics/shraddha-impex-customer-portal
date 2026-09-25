/**
 * The role baseline top-up (utils/roleBaseline.js).
 *
 * The fixture is the Sales row as it stood in the live database on 2026-09-25:
 * seeded before VIEW_PRICING and the O2D / Work Queue keys joined the Sales
 * baseline, so once the row became the whole answer Sales could see no prices
 * on the Sales Desk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { baselineTopUp } from '../utils/roleBaseline.js';
import { compileGrants } from '../config/moduleRegistry.js';
import { PERMISSIONS, baselineFor } from '../config/permissions.js';

const STALE_SALES_ROW = {
  name: 'Sales',
  permissions: [],
  grants: [
    { module: 'customer_portal', submodule: 'dashboard', actions: ['view'] },
    { module: 'customer_portal', submodule: 'booking_history', actions: ['view', 'edit'] },
    { module: 'customer_portal', submodule: 'indent_history', actions: ['view'] },
    { module: 'customer_portal', submodule: 'catalogue', actions: ['view'] },
    { module: 'customer_portal', submodule: 'profile', actions: ['view', 'edit'] },
    { module: 'customer_portal', submodule: 'support', actions: ['view'] },
    { module: 'sales', submodule: 'bookings', actions: ['view', 'edit', 'approve'] },
    { module: 'inventory', submodule: 'dashboard', actions: ['view'] },
    { module: 'inventory', submodule: 'master', actions: ['view'] },
    { module: 'inventory', submodule: 'health', actions: ['view'] },
    { module: 'inventory', submodule: 'imports', actions: ['view'] },
    { module: 'inventory', submodule: 'adjustments', actions: ['view'] },
    { module: 'inventory', submodule: 'counts', actions: ['view'] },
    { module: 'inventory', submodule: 'alerts', actions: ['view'] },
    { module: 'inventory', submodule: 'configuration', actions: ['view'] },
    { module: 'reports', submodule: 'operational', actions: ['view'] },
    { module: 'customer_portal', submodule: 'create_booking', actions: ['view', 'create'] },
    { module: 'customer_portal', submodule: 'bulk_upload', actions: ['view', 'create'] },
  ],
};

const resolved = ({ grants, permissions }) => new Set([...compileGrants(grants), ...permissions]);

test('the stale Sales row does not hold view_pricing — the regression', () => {
  assert.equal(resolved(STALE_SALES_ROW).has(PERMISSIONS.VIEW_PRICING), false);
});

test('the top-up restores view_pricing to Sales, through the Customer Pricing cell', () => {
  const topUp = baselineTopUp(STALE_SALES_ROW, baselineFor('Sales'));
  assert.equal(topUp.changed, true);
  assert.ok(topUp.missing.includes(PERMISSIONS.VIEW_PRICING));
  assert.ok(resolved(topUp).has(PERMISSIONS.VIEW_PRICING));
  // A matrix cell, so the Super Admin sees it ticked — not a hidden flat key.
  const cell = topUp.grants.find((g) => g.module === 'sales' && g.submodule === 'pricing');
  assert.deepEqual(cell?.actions, ['view']);
});

test('after the top-up the row resolves to at least the whole Sales baseline', () => {
  const after = resolved(baselineTopUp(STALE_SALES_ROW, baselineFor('Sales')));
  const missing = baselineFor('Sales').filter((key) => !after.has(key));
  assert.deepEqual(missing, []);
});

test('it only adds: every existing cell and action survives', () => {
  const extra = {
    ...STALE_SALES_ROW,
    // Something outside the baseline an administrator ticked on purpose.
    grants: [...STALE_SALES_ROW.grants, { module: 'sales', submodule: 'bookings', actions: ['delete'] }],
    permissions: ['some_legacy_key'],
  };
  const topUp = baselineTopUp(extra, baselineFor('Sales'));
  const before = resolved(extra);
  const after = resolved(topUp);
  for (const key of before) assert.ok(after.has(key), `lost ${key}`);
  assert.ok(topUp.permissions.includes('some_legacy_key'));
});

test('it is idempotent — a topped-up row needs nothing more', () => {
  const once = baselineTopUp(STALE_SALES_ROW, baselineFor('Sales'));
  const twice = baselineTopUp({ ...STALE_SALES_ROW, ...once }, baselineFor('Sales'));
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.missing, []);
});

test('a wildcard baseline and a missing row are left alone', () => {
  assert.equal(baselineTopUp({ grants: [], permissions: [] }, ['*']).changed, false);
  assert.equal(baselineTopUp(null, baselineFor('Sales')).changed, false);
});
