/**
 * Turning grant lists into something a checkbox grid can read, and back.
 *
 * Two screens draw a permission matrix - a ROLE's, and one ACCOUNT's extra
 * access on top of its role - and they are the same grid over the same
 * registry. These helpers live here rather than in either screen so the two
 * cannot drift into disagreeing about what a tick means.
 *
 * The wire format is a LIST of `{ module, submodule, actions[] }`, which is
 * what the API stores and what reads well in a database row. A grid wants a
 * lookup instead, so it is converted on the way in and back on the way out.
 */

export const ACTION_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
};

/** Grants are a list; the matrix wants a lookup. 'module.submodule' -> Set. */
export const grantsToMap = (grants = []) => {
  const map = new Map();
  for (const g of grants) {
    map.set(`${g.module}.${g.submodule}`, new Set(g.actions || []));
  }
  return map;
};

/** Back to the wire format. Sub-modules with nothing ticked are dropped. */
export const mapToGrants = (map) =>
  [...map.entries()]
    .filter(([, actions]) => actions.size > 0)
    .map(([id, actions]) => {
      const [module, submodule] = id.split('.');
      return { module, submodule, actions: [...actions] };
    });

/**
 * Do two grant lists mean the same thing?
 *
 * Order-insensitive on both axes, because it decides whether the Save button is
 * enabled: comparing raw JSON would light it up after a tick and an untick that
 * cancelled out, and an admin who is told they have unsaved changes when they
 * do not soon stops believing the button.
 */
export const sameGrants = (a = [], b = []) => {
  const norm = (g) =>
    JSON.stringify(
      [...g]
        .map((x) => ({ ...x, actions: [...(x.actions || [])].sort() }))
        .sort((p, q) => `${p.module}.${p.submodule}`.localeCompare(`${q.module}.${q.submodule}`)),
    );
  return norm(a) === norm(b);
};

/** Is this action ticked for this sub-module in the given map? */
export const mapHas = (map, moduleKey, subKey, action) =>
  map.get(`${moduleKey}.${subKey}`)?.has(action) || false;

/** Toggle one cell, returning a NEW map (the grids hold these in state). */
export const toggleCell = (map, moduleKey, subKey, action) => {
  const next = new Map(map);
  const id = `${moduleKey}.${subKey}`;
  const actions = new Set(next.get(id) || []);
  if (actions.has(action)) actions.delete(action);
  else actions.add(action);
  next.set(id, actions);
  return next;
};

export default {
  ACTION_LABELS,
  grantsToMap,
  mapToGrants,
  sameGrants,
  mapHas,
  toggleCell,
};
