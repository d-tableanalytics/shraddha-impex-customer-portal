import { registryForClient, keysForGrant } from '../config/moduleRegistry.js';
import { currentPortal } from '../config/portal.js';

/**
 * A grants save that can only change THIS portal's cells.
 *
 * WHY THE SERVER HAS TO DO THIS
 *
 * `Role.grants` and `User.extraGrants` are one array per document, shared by
 * both portals: a Sales role carries Customer Portal cells (sales.bookings,
 * inventory.*) and Employee Portal cells (o2d.*, work_queue.*) side by side.
 * Each portal's Roles & Permissions screen shows only its own modules.
 *
 * The save endpoints REPLACE the array with what the client sent. The Employee
 * Portal stays safe only because its screen seeds its draft from every stored
 * cell and sends them all back. Nothing on the server enforced that, so one
 * screen that sent only what it rendered would silently strip every HRMS, O2D
 * and Work Queue grant from the role, with no error and no undo.
 *
 * This portal does not rely on the client for it. A save here keeps every
 * stored cell for a sub-module this portal does not serve, whatever arrives,
 * and takes from the request only the cells for sub-modules this portal does
 * serve. So the Customer Portal can neither remove nor add an Employee Portal
 * grant, however its request is built.
 */

const cellKey = (grant) => `${grant.module}.${grant.submodule}`;

/** `module.submodule` for every sub-module this deployment's portal serves. */
export const servedCellKeys = (portal = currentPortal()) => {
  const keys = new Set();
  for (const mod of registryForClient(portal)) {
    for (const sub of mod.submodules) keys.add(`${mod.key}.${sub.key}`);
  }
  return keys;
};

/**
 * The array to store: other portals' cells from `stored`, this portal's from
 * `incoming`.
 *
 * @param {Array} stored   the document's current grants
 * @param {Array} incoming validated grants from the request
 */
export const mergeServedGrants = (stored = [], incoming = [], portal = currentPortal()) => {
  const served = servedCellKeys(portal);
  const kept = (stored || []).filter((g) => g?.module && g?.submodule && !served.has(cellKey(g)));
  const taken = (incoming || []).filter((g) => served.has(cellKey(g)));
  return [...kept, ...taken].map((g) => ({
    module: g.module,
    submodule: g.submodule,
    actions: [...(g.actions || [])],
  }));
};

/** Every flat key a cell this portal serves can grant. */
export const servedPermissionKeys = (portal = currentPortal()) => {
  const keys = new Set();
  for (const mod of registryForClient(portal)) {
    for (const sub of mod.submodules) {
      for (const action of sub.actions) {
        for (const key of keysForGrant(mod.key, sub.key, action)) keys.add(key);
      }
    }
  }
  return keys;
};

/**
 * The same rule for the legacy flat `Role.permissions` list: keys this portal
 * serves come from the request, every other stored key is kept.
 */
export const mergeServedPermissions = (stored = [], incoming = [], portal = currentPortal()) => {
  const served = servedPermissionKeys(portal);
  const kept = (stored || []).filter((k) => !served.has(k));
  const taken = (incoming || []).filter((k) => served.has(k));
  return [...new Set([...kept, ...taken])];
};

/**
 * CELLS THAT COMPILE TO MORE THAN THEIR LABEL SAYS.
 *
 * A cell lists the keys that ADMIT someone (roleResolver's satisfiesCell is
 * ANY), but compileGrants turns a ticked cell into ALL of its keys. For most
 * cells that is the same thing. For these it is an escalation:
 *
 *   administration.customers  view/create/edit  -> manage_customer_users AND
 *                             manage_users, i.e. full user administration,
 *                             internal accounts and Admins included.
 *   customer_portal.create_booking / bulk_upload  view -> create_order AND
 *                             view_all_bookings, i.e. every customer's bookings.
 *   administration.overview   view -> manage_users AND manage_roles.
 *
 * The real fix is in config/moduleRegistry.js, which is shared-contract code
 * (both repositories, byte-identical). Until then, saves made HERE never store
 * those widening cells:
 *
 *   NARROWED  the tick is stored as the one key it is meant to mean, on the
 *             role's flat `permissions` list, and the widening actions are
 *             stripped from the cell.
 *   DERIVED   the tick cannot be changed from this portal. It follows from
 *             other access (New Booking's View follows its Create; the Admin
 *             Panel follows user or role administration) and whatever is
 *             stored is kept as it is.
 */
export const NARROWED_CELLS = Object.freeze({
  'administration.customers': Object.freeze({ actions: ['view', 'create', 'edit'], key: 'manage_customer_users' }),
});

export const DERIVED_CELLS = Object.freeze({
  'customer_portal.create_booking': Object.freeze(['view']),
  'customer_portal.bulk_upload': Object.freeze(['view']),
  'administration.overview': Object.freeze(['view']),
});

const toPlain = (g) => ({ module: g.module, submodule: g.submodule, actions: [...(g.actions || [])] });

/** Apply DERIVED: incoming derived actions are ignored, stored ones kept. */
const withDerived = (stored, incoming) => {
  const storedByCell = new Map((stored || []).map((g) => [cellKey(g), g]));
  const out = [];
  const seen = new Set();
  for (const g of incoming) {
    const key = cellKey(g);
    seen.add(key);
    const derived = DERIVED_CELLS[key];
    if (!derived) { out.push(toPlain(g)); continue; }
    const kept = (storedByCell.get(key)?.actions || []).filter((a) => derived.includes(a));
    const actions = [...new Set([...g.actions.filter((a) => !derived.includes(a)), ...kept])];
    if (actions.length) out.push({ ...toPlain(g), actions });
  }
  // A derived cell the request left out entirely keeps its stored derived actions.
  for (const [key, derived] of Object.entries(DERIVED_CELLS)) {
    if (seen.has(key)) continue;
    const g = storedByCell.get(key);
    const kept = (g?.actions || []).filter((a) => derived.includes(a));
    if (kept.length) out.push({ module: g.module, submodule: g.submodule, actions: kept });
  }
  return out;
};

/**
 * A ROLE save from this portal: `{ grants, permissions }` to store.
 *
 * Other portals' cells and flat keys are kept as stored (mergeServed*), derived
 * ticks keep their stored value, and a narrowed tick becomes its one key.
 */
export const normaliseRoleSave = ({ storedGrants = [], storedPermissions = [], incomingGrants = [] }, portal = currentPortal()) => {
  const served = servedCellKeys(portal);
  const servedIncoming = (incomingGrants || []).filter((g) => served.has(cellKey(g)));
  const narrowedKeys = new Set(Object.values(NARROWED_CELLS).map((n) => n.key));

  const flat = new Set((storedPermissions || []).filter((k) => !narrowedKeys.has(k)));
  const cells = [];
  for (const g of withDerived(storedGrants.filter((x) => served.has(cellKey(x))), servedIncoming)) {
    const narrowed = NARROWED_CELLS[cellKey(g)];
    if (!narrowed) { cells.push(g); continue; }
    if (g.actions.some((a) => narrowed.actions.includes(a))) flat.add(narrowed.key);
    const rest = g.actions.filter((a) => !narrowed.actions.includes(a));
    if (rest.length) cells.push({ ...g, actions: rest });
  }

  return {
    grants: mergeServedGrants(storedGrants, cells, portal),
    permissions: [...flat],
  };
};

/**
 * An ACCOUNT's extra access saved from this portal. Extras are cells only (no
 * flat list), so a narrowed tick cannot be translated and is refused instead.
 *
 * @returns {{ grants: Array } | { error: string }}
 */
export const normaliseExtraGrants = ({ storedGrants = [], incomingGrants = [] }, portal = currentPortal()) => {
  const served = servedCellKeys(portal);
  const servedIncoming = (incomingGrants || []).filter((g) => served.has(cellKey(g)));
  for (const g of servedIncoming) {
    const narrowed = NARROWED_CELLS[cellKey(g)];
    if (narrowed && g.actions.some((a) => narrowed.actions.includes(a))) {
      return {
        error: 'Customer Management cannot be given as extra access: that cell also grants full user '
          + 'administration. Put the account on a role that holds it (Sales does) instead.',
      };
    }
  }
  const cells = withDerived(storedGrants.filter((x) => served.has(cellKey(x))), servedIncoming);
  return { grants: mergeServedGrants(storedGrants, cells, portal) };
};

/** The rules above, as the matrix screen needs them. */
export const matrixRules = () => ({
  narrowed: Object.fromEntries(Object.entries(NARROWED_CELLS).map(([k, v]) => [k, { actions: v.actions, key: v.key }])),
  derived: Object.fromEntries(Object.entries(DERIVED_CELLS).map(([k, v]) => [k, [...v]])),
});

export default {
  servedCellKeys, mergeServedGrants, servedPermissionKeys, mergeServedPermissions,
  normaliseRoleSave, normaliseExtraGrants, matrixRules, NARROWED_CELLS, DERIVED_CELLS,
};
