import { createProductModel, registerBrandValue } from '../models/Product.js';
import { INVENTORY_ROLES, isSuperAdmin, hasPermission, PERMISSIONS } from '../middlewares/rbac.js';
import { isInternalRoleName } from './roleResolver.js';
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
 * Accounts the per-user `brandAccess` flags do NOT apply to.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES
 * ---------------------------------------------------------------------------
 *
 * `brandAccess` is a per-ACCOUNT set of flags whose purpose is to scope a
 * CUSTOMER to the brands they buy. It is ticked on an account in Customer
 * Users and nowhere else: no staff onboarding path sets it, so every ordinary
 * internal account carries the schema default
 * `{ koken: false, bix: false, imada: false }`.
 *
 * This predicate used to be `isSuperAdmin(user) || INVENTORY_ROLES.includes(role)`
 * — an allowlist of four warehouse roles. Sales, Billing, Accounts, Billing
 * Head and HR all fell outside it, so `allowedBrands()` returned `[]` for them
 * and every brand-scoped read resolved to nothing.
 *
 * That is the root cause of the reported Product Catalogue defect. A Sales
 * user holding `view_catalogue` passed the route guard, reached
 * `getInventory`, and was handed an empty list with HTTP 200 — no 403, no
 * error, just no rows, because `allowedBrandModels(user)` had no models to
 * query. The permission was never the problem; the brand fence was.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEST IS "HAS ANY BRAND BEEN TICKED", NOT "IS THIS A STAFF ROLE"
 * ---------------------------------------------------------------------------
 *
 * Widening it to "every internal role sees every brand" would have fixed the
 * symptom and removed a capability the system deliberately has: a Super Admin
 * can create a staff role and scope that ACCOUNT to one brand — a Koken-only
 * auditor, a BIX-only salesperson. Those accounts exist and are exercised by
 * the brand-fence tests. Role name is the wrong axis for a per-account fence.
 *
 * So the question asked is the one the data can actually answer: HAS ANYBODY
 * SCOPED THIS ACCOUNT? An internal account with at least one brand ticked was
 * scoped on purpose and stays scoped. An internal account with none was never
 * scoped at all, and reading that as "scoped to nothing" is what blinded the
 * sales desk.
 *
 * ---------------------------------------------------------------------------
 * AND WHY A CUSTOMER STILL FAILS CLOSED
 * ---------------------------------------------------------------------------
 *
 * The relaxation applies ONLY to an account whose role this system knows and
 * which is not fenced into the Customer Portal. A Customer — or any role a
 * Super Admin marks `portalOnly` — with no brands ticked still resolves to
 * `[]` and still sees nothing, which is what `brandFilter()`'s
 * `{ brand: { $in: [] } }` has always promised. `isInternalRoleName` is itself
 * fail-closed on an absent, blank or unknown role, so a malformed account gets
 * the customer fence rather than being widened to everything.
 *
 * It grants no permission. A Sales user still sees only the modules their
 * permission set allows; this only stops a list they were already authorised
 * to read from arriving empty.
 *
 * INVENTORY_ROLES stays in the expression deliberately: those four names are
 * compiled in, so they answer correctly even on a cold role cache, before
 * `loadRoles()` has run, and they see every brand even if somebody ticks a
 * flag on one of their accounts by mistake.
 */
const hasAnyBrandFlag = (brandAccess) =>
  listBrands().some((b) => hasBrandFlag(brandAccess, b.key));

const seesAllBrands = (user) =>
  isSuperAdmin(user)
  || INVENTORY_ROLES.includes(user?.role)
  || (isInternalRoleName(user?.role) && !hasAnyBrandFlag(user?.brandAccess));

/**
 * True when this account's brands come from its own `brandAccess` flags. Sent
 * to the browser on sign-in so the UI applies the same rule without having to
 * know any role names — see modules/auth/auth.controller.js.
 */
export const isBrandScopedAccount = (user) => !seesAllBrands(user);

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
  allBrands, allowedBrands, canAccessBrand, brandOfProduct, allBrandModels, allowedBrandModels,
  brandFilter, brandsVisibleTo, isBrandScopedAccount,
};
