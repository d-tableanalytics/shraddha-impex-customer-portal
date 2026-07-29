/**
 * Brand-access rules for the UI. Mirrors backend/utils/brandAccess.js — keep
 * the two in step.
 *
 * This is presentation only: it decides what the portal offers, never what it
 * is allowed to read. The server enforces the same rules independently, so a
 * hand-crafted request cannot reach a hidden brand.
 *
 *   • Admins always see every brand.
 *   • MSIL customers never carry IMADA, regardless of the flag.
 */

export const ALL_BRANDS = ["Koken", "BIX", "IMADA"];

const isAdmin = (user) => user?.role === "Admin";
const isMsilCustomer = (user) => !isAdmin(user) && user?.customerCategory === "MSIL";

/** Canonical brand names this user may see, e.g. ['Koken', 'BIX']. */
export const allowedBrands = (user) => {
  if (isAdmin(user)) return [...ALL_BRANDS];
  const out = [];
  if (user?.brandAccess?.koken) out.push("Koken");
  if (user?.brandAccess?.bix) out.push("BIX");
  if (user?.brandAccess?.imada && !isMsilCustomer(user)) out.push("IMADA");
  return out;
};

/** True when the user may see the given brand. Case-insensitive. */
export const canAccessBrand = (user, brand) => {
  if (!brand) return false;
  const b = String(brand).toLowerCase();
  return allowedBrands(user).some((x) => x.toLowerCase() === b);
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

export default { ALL_BRANDS, allowedBrands, canAccessBrand, defaultBrand };
