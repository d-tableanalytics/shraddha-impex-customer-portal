import { ProductKoken, ProductBIX, ProductIMADA } from '../models/Product.js';
import { INVENTORY_ROLES } from '../middlewares/rbac.js';

/**
 * Central brand-access rules.
 *
 * A customer only ever sees the brands ticked in their `brandAccess` flags.
 * Two standing rules on top of that:
 *   • Admins and internal inventory staff always see every brand.
 *   • MSIL customers never carry IMADA, regardless of the flag — this mirrors
 *     the rule already applied in the inventory and dashboard endpoints.
 *
 * Everything brand-scoped should go through here rather than re-deriving the
 * rule, so a brand can never leak through a path that forgot to check.
 */

export const ALL_BRANDS = ['Koken', 'BIX', 'IMADA'];

const MODEL_BY_BRAND = {
  koken: ProductKoken,
  bix: ProductBIX,
  imada: ProductIMADA,
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
  user?.role === 'Admin' || INVENTORY_ROLES.includes(user?.role);

const isMsilCustomer = (user) => !seesAllBrands(user) && user?.customerCategory === 'MSIL';

/**
 * Canonical brand names this user may see, e.g. ['Koken', 'BIX'].
 */
export const allowedBrands = (user) => {
  if (seesAllBrands(user)) return [...ALL_BRANDS];
  const out = [];
  if (user?.brandAccess?.koken) out.push('Koken');
  if (user?.brandAccess?.bix) out.push('BIX');
  if (user?.brandAccess?.imada && !isMsilCustomer(user)) out.push('IMADA');
  return out;
};

/**
 * True when the user may see/act on the given brand. Case-insensitive, and
 * tolerant of a null/blank brand (treated as not allowed).
 */
export const canAccessBrand = (user, brand) => {
  if (!brand) return false;
  const b = String(brand).toLowerCase();
  return allowedBrands(user).some((x) => x.toLowerCase() === b);
};

/**
 * [[Model, brandName], ...] for the brands this user may query. Iterate this
 * instead of a hardcoded BRAND_MODELS list so lookups cannot cross a brand
 * boundary the user has no access to.
 */
export const allowedBrandModels = (user) =>
  allowedBrands(user).map((brand) => [MODEL_BY_BRAND[brand.toLowerCase()], brand]);

/**
 * Mongo filter fragment restricting a brand-carrying collection (e.g. Order)
 * to the user's brands. Admins get `{}` so no needless clause is added.
 *
 * A user with NO brand access yields `{ brand: { $in: [] } }`, which correctly
 * matches nothing rather than silently matching everything.
 */
export const brandFilter = (user) =>
  seesAllBrands(user) ? {} : { brand: { $in: allowedBrands(user) } };

export default { ALL_BRANDS, allowedBrands, canAccessBrand, allowedBrandModels, brandFilter };
