/**
 * Brand-access rules for the UI. Mirrors backend/utils/brandAccess.js — keep
 * the two in step.
 *
 * This is presentation only: it decides what the portal offers, never what it
 * is allowed to read. The server enforces the same rules independently, so a
 * hand-crafted request cannot reach a hidden brand.
 *
 *   • Admins and internal inventory staff always see every brand.
 *   • A brand flagged `hiddenFromMsil` (IMADA, and any new brand that opts in)
 *     is never offered to an MSIL customer, regardless of the flag.
 *
 * THE BRAND LIST IS DATA, NOT CODE. It arrives with the signed-in user
 * (`/auth/me` → `brands`) and is installed here by setBrandRegistry(), so a
 * brand created in Inventory Configuration reaches every dropdown and filter
 * that calls allowedBrands() — which is all of them — without any screen
 * knowing a brand name. Until the first load it holds the three built-in
 * brands, so nothing renders with an empty list.
 */

import { isSuperAdmin, INVENTORY_ROLES } from "./permissions";

const BUILT_IN = [
  { name: "Koken", key: "koken", hiddenFromMsil: false },
  { name: "BIX", key: "bix", hiddenFromMsil: false },
  { name: "IMADA", key: "imada", hiddenFromMsil: true },
];

let registry = BUILT_IN;

/** An OWN, truthy flag — an inherited property such as `constructor` never counts. */
export const hasBrandFlag = (brandAccess, key) => Boolean(
  brandAccess && typeof brandAccess === "object"
    && Object.prototype.hasOwnProperty.call(brandAccess, key) && brandAccess[key],
);

/**
 * Install the brand list the server sent. A response WITHOUT `brands` (not an
 * array) leaves the list alone; an EMPTY list is taken as it is — a customer
 * with no brands must not keep the previous session's list in this tab.
 */
export const setBrandRegistry = (brands) => {
  if (!Array.isArray(brands)) return;
  registry = brands
    .filter((b) => b && typeof b.name === "string" && typeof b.key === "string")
    .map((b) => ({ name: b.name, key: b.key, hiddenFromMsil: Boolean(b.hiddenFromMsil) }));
};

/** Every brand this browser knows about: [{ name, key, hiddenFromMsil }]. */
export const listBrands = () => registry;

/** Every brand name, e.g. ['Koken', 'BIX', 'IMADA', ...]. */
export const allBrands = () => registry.map((b) => b.name);

/**
 * Does this account see every configured brand?
 *
 * THE SERVER ANSWERS THIS. `brandScoped` arrives with the signed-in user
 * (`/auth/me`) and is `false` for an account whose brands were never scoped —
 * internal staff with no brand ticked — and `true` for a customer, or for any
 * account somebody deliberately fenced to a subset. The rule depends on the
 * role model and on the account's own flags, and a browser carrying its own
 * list of role names goes stale the moment a Super Admin invents one.
 *
 * That staleness is the defect this fixes. The list below holds four warehouse
 * roles, so a Sales user — who holds view_catalogue — was treated as a customer
 * with no brands ticked, and every brand filter, dropdown and catalogue page
 * narrowed itself to nothing before a request was even sent.
 *
 * The old expression is kept as the FALLBACK, for a user object that predates
 * the field (a restored session, an older server). Behaviour is then exactly
 * what it was, so nothing regresses while a deployment is half-rolled.
 */
const seesAllBrands = (user) => {
  if (typeof user?.brandScoped === "boolean") return !user.brandScoped;
  return isSuperAdmin(user) || INVENTORY_ROLES.includes(user?.role);
};

const isMsilCustomer = (user) => !seesAllBrands(user) && user?.customerCategory === "MSIL";

/** Canonical brand names this user may see, e.g. ['Koken', 'BIX']. */
export const allowedBrands = (user) => {
  if (seesAllBrands(user)) return allBrands();
  const msil = isMsilCustomer(user);
  return registry
    .filter((b) => hasBrandFlag(user?.brandAccess, b.key) && !(b.hiddenFromMsil && msil))
    .map((b) => b.name);
};

/** True when the user may see the given brand. Case-insensitive. */
export const canAccessBrand = (user, brand) => {
  if (!brand) return false;
  const b = String(brand).toLowerCase();
  // Name in any case, or the brand's key — the same spellings the server accepts.
  const allowed = new Set(allowedBrands(user));
  return registry.some((x) => allowed.has(x.name) && (x.name.toLowerCase() === b || x.key === b));
};

/**
 * Lower-cased id of the brand to query by default, or null when the user has
 * no brand access at all. Callers must handle null rather than defaulting to a
 * brand the user may not be allowed to see.
 */
export const defaultBrand = (user) => {
  const [first] = allowedBrands(user);
  return first ? first.toLowerCase() : null;
};

export default { setBrandRegistry, listBrands, allBrands, allowedBrands, canAccessBrand, defaultBrand };
