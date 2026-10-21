import Brand from '../models/Brand.js';

/**
 * The brand list, mirrored in memory.
 *
 * SHARED CONTRACT — byte-identical in both portals and listed in
 * shared-contract.manifest.json, because it decides how the shared `users`
 * collection's `brandAccess` flags are read and written.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SYNCHRONOUS CACHE
 * ─────────────────────────────────────────────────────────────────────────
 * allowedBrands(user) and canAccessBrand(user, brand) are called synchronously
 * from dozens of controllers, often inside a map over query results. Making the
 * brand list database-backed the obvious way would turn every one of them
 * async. The list is tiny and changes only when an administrator adds or
 * removes a brand, so — exactly like the role cache in roleResolver.js — it is
 * loaded at boot, refreshed after this process's own writes, and re-read on an
 * interval so a brand added through the OTHER portal arrives within a minute.
 *
 * The three brands the system shipped with are compiled in. An empty or
 * unreachable `brands` collection therefore leaves the business exactly where
 * it was before brands were configurable, never with no brands at all.
 */

/** The brands the system shipped with, in their long-standing display order. */
export const DEFAULT_BRANDS = Object.freeze([
  Object.freeze({ name: 'Koken', key: 'koken', hiddenFromMsil: false, system: true }),
  Object.freeze({ name: 'BIX', key: 'bix', hiddenFromMsil: false, system: true }),
  // "MSIL customers never carry IMADA" — now a flag rather than a special case.
  Object.freeze({ name: 'IMADA', key: 'imada', hiddenFromMsil: true, system: true }),
]);

let brands = DEFAULT_BRANDS;
let loadedAt = null;
const listeners = new Set();

/** 'Stanley Tools' -> 'stanleytools'. The User.brandAccess field name. */
export const brandKeyFor = (name) =>
  String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is this an acceptable name for a NEW brand? Returns an error message or null.
 *
 * Letters, digits, spaces and a little punctuation, because the name is printed
 * on purchase orders and used as a stored value everywhere. Must contain a
 * letter, so the key derived from it is never empty or purely numeric.
 */
export const brandNameProblem = (raw) => {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return 'A brand name is required.';
  if (name.length < 2 || name.length > 30) return 'A brand name must be 2 to 30 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 &.\-]*$/.test(name)) {
    return 'A brand name may use letters, digits, spaces and & . - only.';
  }
  if (!/[A-Za-z]/.test(name)) return 'A brand name must contain at least one letter.';
  // A key that is also a property every JavaScript object inherits would read
  // as "granted" on every account (`brandAccess.constructor` is a function).
  if (RESERVED_KEYS.has(brandKeyFor(name))) return `"${name}" cannot be used as a brand name.`;
  return null;
};

/** Keys every object inherits — never valid brand keys. */
const RESERVED_KEYS = new Set(
  [...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map((k) => brandKeyFor(k)).filter(Boolean),
);

/**
 * Does this brandAccess object grant the brand? An OWN property only, so a
 * key that happens to match an inherited property can never read as true.
 */
export const hasBrandFlag = (brandAccess, key) => Boolean(
  brandAccess && typeof brandAccess === 'object'
    && Object.prototype.hasOwnProperty.call(brandAccess, key) && brandAccess[key],
);

/** Every brand, in display order: the built-in three first, then by name. */
export const listBrands = () => brands;

/** ['Koken', 'BIX', 'IMADA', ...] */
export const brandNames = () => brands.map((b) => b.name);

/**
 * The brand a caller meant, or null. Accepts the name in any case ('koken',
 * 'KOKEN') or the key, because brand values cross URLs, spreadsheets and forms.
 */
export const findBrand = (raw) => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  return brands.find((b) => b.name.toLowerCase() === text || b.key === text) ?? null;
};

/** The stored spelling of a brand ('koken' -> 'Koken'), or null if unknown. */
export const canonicalBrand = (raw) => findBrand(raw)?.name ?? null;

/**
 * Run `fn(brands)` whenever the list changes, and once now. How the Customer
 * Portal registers a product model per brand without this file importing the
 * product model (which the Employee Portal does not have).
 */
export const onBrandsChanged = (fn) => {
  listeners.add(fn);
  fn(brands);
  return () => listeners.delete(fn);
};

const order = (list) => {
  const builtIn = new Map(DEFAULT_BRANDS.map((b, i) => [b.key, i]));
  return [...list].sort((a, b) => {
    const ai = builtIn.has(a.key) ? builtIn.get(a.key) : Infinity;
    const bi = builtIn.has(b.key) ? builtIn.get(b.key) : Infinity;
    return ai - bi || a.name.localeCompare(b.name);
  });
};

const apply = (rows) => {
  const byKey = new Map(DEFAULT_BRANDS.map((b) => [b.key, b]));
  for (const row of rows) {
    if (!row?.key || !row?.name) continue;
    byKey.set(row.key, Object.freeze({
      name: row.name,
      key: row.key,
      hiddenFromMsil: Boolean(row.hiddenFromMsil),
      system: Boolean(row.system) || DEFAULT_BRANDS.some((d) => d.key === row.key),
    }));
  }
  brands = Object.freeze(order([...byKey.values()]));
  loadedAt = new Date();
  for (const fn of listeners) {
    try { fn(brands); } catch (error) { console.error('[Brands] listener failed:', error.message); }
  }
  return brands.length;
};

/**
 * Re-read the collection. Never throws: on failure the last good list stays,
 * so a database blip cannot make a brand disappear from a running system.
 */
export const loadBrands = async () => {
  try {
    return apply(await Brand.find({}, 'name key hiddenFromMsil system').lean());
  } catch (error) {
    console.error('[Brands] Could not refresh the brand list:', error.message);
    return brands.length;
  }
};

/**
 * Make sure the built-in brands exist as documents, then load. Idempotent:
 * an existing row is never overwritten, so a flag an administrator changed
 * survives every restart.
 */
export const seedBrands = async () => {
  try {
    await Brand.bulkWrite(DEFAULT_BRANDS.map((b) => ({
      updateOne: {
        filter: { key: b.key },
        update: { $setOnInsert: { ...b } },
        upsert: true,
      },
    })), { ordered: false });
  } catch (error) {
    console.error('[Brands] Could not seed the built-in brands:', error.message);
  }
  return loadBrands();
};

export const brandCacheStatus = () => ({ loadedAt, count: brands.length });

/** What a stored brandAccess key may look like: a Brand.key, never an operator or a path. */
const KEY_SHAPE = /^[a-z0-9]{1,30}$/;

/**
 * The brandAccess object to STORE, given what is stored and what was sent.
 *
 * MERGED PER BRAND, never replaced wholesale.
 *
 *   - A brand the request mentions takes the sent value, as a boolean — but
 *     only for a brand THIS process knows, so a request cannot invent keys.
 *   - Every STORED flag the request does not mention is kept as it is, even
 *     for a brand this process has not loaded yet. The two portals refresh
 *     their brand lists independently (up to a minute apart); dropping
 *     "unknown" stored keys would let a save in the lagging portal silently
 *     revoke a brand created a moment ago in the other. Deleting a brand is
 *     what removes its flags (brand.controller.js), never a save.
 */
export const mergeBrandAccess = (stored, incoming) => {
  const out = {};
  const keep = stored && typeof stored === 'object' ? stored : {};
  const sent = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  for (const key of Object.keys(keep)) {
    if (KEY_SHAPE.test(key) && !RESERVED_KEYS.has(key)) out[key] = Boolean(keep[key]);
  }
  for (const { key } of brands) {
    if (Object.prototype.hasOwnProperty.call(sent, key)) out[key] = Boolean(sent[key]);
  }
  return out;
};

export default {
  DEFAULT_BRANDS, brandKeyFor, brandNameProblem, listBrands, brandNames, findBrand,
  canonicalBrand, onBrandsChanged, loadBrands, seedBrands, brandCacheStatus, mergeBrandAccess, hasBrandFlag,
};
