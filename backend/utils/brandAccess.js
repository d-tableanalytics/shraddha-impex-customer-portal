import { createProductModel, registerBrandValue } from '../models/Product.js';
import { INVENTORY_ROLES, isSuperAdmin, hasPermission, PERMISSIONS } from '../middlewares/rbac.js';
import {
  listBrands, brandNames, onBrandsChanged, canonicalBrand, hasBrandFlag,
} from './brandRegistry.js';

/**
 * Central brand-access rules.
 *
 * A customer only ever sees the brands ticked in their `brandAccess` flags.
 * Two standing rules on top of that:
 *   • Admins and internal inventory staff always see every brand.
 *   • A brand flagged `hiddenFromMsil` (IMADA, and any new brand that opts in)
 *     is never shown to an MSIL customer, regardless of the flag.
 *
 * The brand LIST comes from utils/brandRegistry.js — the `brands` collection,
 * mirrored in memory — so a brand created from Inventory Configuration reaches
 * every caller below without any of them changing.
 *
 * Everything brand-scoped should go through here rather than re-deriving the
 * rule, so a brand can never leak through a path that forgot to check.
 */

/**
 * Every brand name, e.g. ['Koken', 'BIX', 'IMADA']. A function, not a
 * constant: the list changes at runtime, and a captured array would not.
 */
export const allBrands = () => brandNames();

// One product model per brand, registered as brands appear. The stored brand
// value has to be known to the product model before a discriminator is made
// for it, or a new brand's products would be stamped with its key.
onBrandsChanged((brands) => {
  for (const b of brands) {
    registerBrandValue(b.key, b.name);
    createProductModel(b.name);
  }
});

/**
 * The brand a product document belongs to — read from the `brand` field the
 * discriminator stores on every product, never guessed from the model's name.
 * Guessing ("the model name contains 'bix', else Koken") filed every brand the
 * guess did not know about as Koken.
 */
export const brandOfProduct = (doc) => {
  const raw = doc?.brand ?? (typeof doc?.get === 'function' ? doc.get('brand') : null);
  return canonicalBrand(raw) ?? raw ?? null;
};

/**
 * Roles that act on the business's own stock rather than their own orders, so
 * the per-user brandAccess flags — which exist to scope CUSTOMERS — do not
 * apply to them.
 *
 * Sales is deliberately NOT in this list. Its brand visibility is already
 * decided by the sales-desk rules, and widening it here would silently change
 * what existing Sales users see on the dashboard and in their booking lists.
 */
const seesAllBrands = (user) =>
  isSuperAdmin(user) || INVENTORY_ROLES.includes(user?.role);

const isMsilCustomer = (user) => !seesAllBrands(user) && user?.customerCategory === 'MSIL';

/**
 * Canonical brand names this user may see, e.g. ['Koken', 'BIX'].
 */
export const allowedBrands = (user) => {
  if (seesAllBrands(user)) return allBrands();
  const msil = isMsilCustomer(user);
  return listBrands()
    .filter((b) => hasBrandFlag(user?.brandAccess, b.key) && !(b.hiddenFromMsil && msil))
    .map((b) => b.name);
};

/**
 * True when the user may see/act on the given brand. Case-insensitive, and
 * tolerant of a null/blank brand (treated as not allowed).
 */
export const canAccessBrand = (user, brand) => {
  if (!brand) return false;
  // Name in any case, or the brand's key ('stanleytools') — the same spellings
  // the product-model lookup accepts, so the two can never disagree about
  // whether a brand in a URL is the same brand.
  const b = String(canonicalBrand(brand) ?? brand).toLowerCase();
  return allowedBrands(user).some((x) => x.toLowerCase() === b);
};

/**
 * [[Model, brandName], ...] for every brand. Internal and system callers only
 * (an expiry job, a SKU lookup with no user) — a request path uses
 * allowedBrandModels(user).
 */
export const allBrandModels = () =>
  allBrands().map((brand) => [createProductModel(brand), brand]);

/**
 * [[Model, brandName], ...] for the brands this user may query. Iterate this
 * instead of a hardcoded list so lookups cannot cross a brand boundary the
 * user has no access to.
 */
export const allowedBrandModels = (user) =>
  allowedBrands(user).map((brand) => [createProductModel(brand), brand]);

/**
 * Mongo filter fragment restricting a brand-carrying collection (e.g. Order)
 * to the user's brands. Admins get `{}` so no needless clause is added.
 *
 * A user with NO brand access yields `{ brand: { $in: [] } }`, which correctly
 * matches nothing rather than silently matching everything.
 */
export const brandFilter = (user) =>
  seesAllBrands(user) ? {} : { brand: { $in: allowedBrands(user) } };

/**
 * The brand list to hand a browser, with the fields its screens need.
 *
 * Everyone who manages accounts or inventory gets the WHOLE list — they tick
 * brands on other people's accounts and pick brands for SKUs. Anyone else gets
 * only the brands they can see, so a customer is never told what else exists.
 */
const SEES_BRAND_LIST = [
  PERMISSIONS.MANAGE_USERS, PERMISSIONS.MANAGE_CUSTOMER_USERS,
  PERMISSIONS.CREATE_USERS, PERMISSIONS.EDIT_USERS, PERMISSIONS.CONFIGURE_INVENTORY,
];
export const brandsVisibleTo = (user) => {
  const all = seesAllBrands(user) || SEES_BRAND_LIST.some((p) => hasPermission(user, p));
  const allowed = all ? null : new Set(allowedBrands(user));
  return listBrands()
    .filter((b) => all || allowed.has(b.name))
    .map(({ name, key, hiddenFromMsil }) => ({ name, key, hiddenFromMsil }));
};

export default {
  allBrands, allowedBrands, canAccessBrand, brandOfProduct, allBrandModels, allowedBrandModels, brandFilter, brandsVisibleTo,
};
