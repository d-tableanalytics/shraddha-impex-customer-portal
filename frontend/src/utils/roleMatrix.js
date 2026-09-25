import { grantsToMap, mapToGrants, sameGrants } from "./grants";

/**
 * What the Roles & Permissions matrix shows for a role, and which boxes it may
 * change. Kept apart from the page so the rules can be tested on their own.
 *
 * The server is the authority for all of it (backend/utils/portalGrants.js) and
 * sends the two special kinds of cell as `registry.rules`:
 *
 *   narrowed  stored as one flat key rather than as the cell, because the cell
 *             compiles to more than its label says. Customer Management is
 *             `manage_customer_users` on the role's flat list; the matrix shows
 *             it ticked when the role holds that key.
 *   derived   cannot be changed from this portal: it follows other access.
 *             Shown, never editable, and never sent as a change.
 *
 * Every other box is the role's stored grant, as-is. The row IS the whole
 * answer (see utils/roleResolver.js on the server), so nothing here merges in a
 * compiled-in baseline: what is ticked is what the role can do.
 */

const FULL_ACCESS_NAMES = new Set(["Super Admin", "Admin"]);

export const isFullAccessRole = (role) => !!role && (role.isSuperAdmin || FULL_ACCESS_NAMES.has(role.name));

const idOf = (moduleKey, subKey) => `${moduleKey}.${subKey}`;

/** The draft a role opens with: its stored cells, plus narrowed keys shown as ticks. */
export const initialDraft = (role, rules = {}) => {
  const map = grantsToMap(role?.grants || []);
  const flat = new Set(role?.permissions || []);
  for (const [id, rule] of Object.entries(rules.narrowed || {})) {
    if (!flat.has(rule.key)) continue;
    const actions = new Set(map.get(id) || []);
    for (const action of rule.actions) actions.add(action);
    map.set(id, actions);
  }
  return map;
};

/** `module.submodule` for every cell in the registry the server sent. */
export const servedIdsOf = (registry) =>
  new Set((registry?.modules || []).flatMap((m) => m.submodules.map((s) => idOf(m.key, s.key))));

/**
 * The grants the page would send for this draft — only what can change here:
 * no derived action, and (given `served`) no cell this screen does not show.
 * The server ignores both anyway; sending neither keeps the request honest.
 */
export const draftToGrants = (draft, rules = {}, served = null) => {
  const derived = rules.derived || {};
  const entries = [...draft.entries()].filter(([id]) => !served || served.has(id));
  return mapToGrants(new Map(entries.map(([id, actions]) => [
    id,
    new Set([...actions].filter((a) => !(derived[id] || []).includes(a))),
  ])));
};

export const isDirty = (draft, role, rules, served = null) =>
  !sameGrants(draftToGrants(draft, rules, served), draftToGrants(initialDraft(role, rules), rules, served));

/**
 * The value a DERIVED box shows, from the rest of the draft.
 *
 *   New Booking / Bulk Upload  View  follows Create (a booking form you may view
 *                              is one you may use), or what is stored.
 *   Admin Panel                View  follows Internal User Management's View.
 */
const derivedValue = (draft, id, action) => {
  if (draft.get(id)?.has(action)) return true;
  if (id === "customer_portal.create_booking" || id === "customer_portal.bulk_upload") {
    return draft.get(id)?.has("create") || false;
  }
  if (id === "administration.overview") {
    return draft.get("administration.users")?.has("view") || false;
  }
  return false;
};

const DERIVED_REASON = {
  "customer_portal.create_booking": "Follows Create: a booking form you can open is one you can use.",
  "customer_portal.bulk_upload": "Follows Create: a booking form you can open is one you can use.",
  "administration.overview": "Follows Internal User Management → View.",
};

/**
 * One box: `{ checked, locked, reason }`.
 *
 * `locked` boxes render disabled with `reason` as their title, so the screen
 * never offers a tick the server would ignore.
 */
export const cellState = ({ role, draft, rules = {}, moduleKey, subKey, action }) => {
  const id = idOf(moduleKey, subKey);

  if (isFullAccessRole(role)) {
    return { checked: true, locked: true, reason: "Full-access role: every permission, always." };
  }
  if (role?.portalOnly && moduleKey !== "customer_portal") {
    return {
      checked: false,
      locked: true,
      reason: "Portal-only role: its accounts are held to the Customer Portal module, whatever is ticked.",
    };
  }
  if ((rules.derived?.[id] || []).includes(action)) {
    return { checked: derivedValue(draft, id, action), locked: true, reason: DERIVED_REASON[id] ?? "Follows other access." };
  }
  const narrowed = rules.narrowed?.[id];
  const reason = narrowed?.actions.includes(action)
    ? `Saved as "${narrowed.key}" — this cell would otherwise also grant full user administration.`
    : null;
  return { checked: draft.get(id)?.has(action) || false, locked: false, reason };
};

/**
 * Toggle a box. Narrowed actions are ONE key on the server, so they move
 * together: ticking Customer Management's View ticks its Create and Edit too,
 * because the saved role cannot hold one without the others.
 */
export const toggle = (draft, rules = {}, moduleKey, subKey, action) => {
  const id = idOf(moduleKey, subKey);
  const next = new Map(draft);
  const actions = new Set(next.get(id) || []);
  const narrowed = rules.narrowed?.[id];
  const group = narrowed?.actions.includes(action) ? narrowed.actions : [action];
  const on = !actions.has(action);
  for (const a of group) {
    if (on) actions.add(a);
    else actions.delete(a);
  }
  next.set(id, actions);
  return next;
};

/**
 * Set a box ON or OFF (rather than flip it), for the bulk controls — ticking a
 * whole module or a whole row. Same narrowed grouping as `toggle`.
 */
export const setCell = (draft, rules = {}, moduleKey, subKey, action, on) => {
  const id = idOf(moduleKey, subKey);
  const next = new Map(draft);
  const actions = new Set(next.get(id) || []);
  const narrowed = rules.narrowed?.[id];
  const group = narrowed?.actions.includes(action) ? narrowed.actions : [action];
  for (const a of group) {
    if (on) actions.add(a);
    else actions.delete(a);
  }
  next.set(id, actions);
  return next;
};

/** Every box the registry offers, ticked — what copying a full-access role copies. */
export const fullDraft = (registry) => {
  const map = new Map();
  for (const mod of registry?.modules || []) {
    for (const sub of mod.submodules) map.set(idOf(mod.key, sub.key), new Set(sub.actions));
  }
  return map;
};

export default {
  isFullAccessRole, initialDraft, servedIdsOf, draftToGrants, isDirty, cellState, toggle, setCell, fullDraft,
};
