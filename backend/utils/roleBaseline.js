import { compileGrants, grantsFromPermissions } from '../config/moduleRegistry.js';

/**
 * What a role row is missing from its compiled-in baseline, and the row that
 * would give it back.
 *
 * WHY THIS EXISTS
 *
 * roleResolver.js used to answer `baseline UNION grants`, so a row seeded before
 * a key was added to the baseline still held that key - the baseline filled the
 * gap. Since the resolver made the row the WHOLE answer, a row carries only what
 * was written into it, and seedRoles.js writes grants just once, to an empty
 * matrix. Every key added to a role's baseline after its row was first seeded -
 * VIEW_PRICING on Sales, the O2D and Work Queue keys - silently stopped applying.
 *
 * This computes the top-up. It only ever ADDS: every cell and flat key the row
 * already has survives, so an administrator's grants are never narrowed. It
 * cannot tell a key that was never written from one an administrator deliberately
 * unticked, which is why scripts/seed-role-baselines.js is a dry run by default
 * and reports exactly what it would restore before anything is written.
 *
 * Pure: takes a plain role document, returns plain data. No database.
 */
export const baselineTopUp = (role, baseline = []) => {
  if (!role || baseline.includes('*')) {
    return { missing: [], grants: role?.grants ?? [], permissions: role?.permissions ?? [], changed: false };
  }

  const existingGrants = role.grants ?? [];
  const existingPermissions = role.permissions ?? [];
  const held = new Set([...compileGrants(existingGrants), ...existingPermissions]);
  const missing = baseline.filter((key) => !held.has(key));
  if (!missing.length) {
    return { missing, grants: existingGrants, permissions: existingPermissions, changed: false };
  }

  // Derived from everything the row will hold, not from `missing` alone: a cell
  // needs EVERY key behind it, and some of those may already be on the row.
  const target = grantsFromPermissions([...held, ...baseline]);

  const byCell = new Map();
  for (const grant of existingGrants) {
    byCell.set(`${grant.module}.${grant.submodule}`, {
      module: grant.module,
      submodule: grant.submodule,
      actions: [...(grant.actions || [])],
    });
  }
  for (const grant of target) {
    const key = `${grant.module}.${grant.submodule}`;
    const cell = byCell.get(key);
    if (!cell) {
      byCell.set(key, { ...grant, actions: [...grant.actions] });
      continue;
    }
    for (const action of grant.actions) {
      if (!cell.actions.includes(action)) cell.actions.push(action);
    }
  }
  const grants = [...byCell.values()];

  // A baseline key no matrix cell can express goes on the legacy flat list,
  // which the resolver still reads, so the row resolves to the full baseline.
  const covered = compileGrants(grants);
  const permissions = [...existingPermissions];
  for (const key of missing) {
    if (!covered.has(key) && !permissions.includes(key)) permissions.push(key);
  }

  return { missing, grants, permissions, changed: true };
};

export default { baselineTopUp };
