/**
 * Customer category and MOQ — the client half of one rule.
 *
 * MOQ (Minimum Order Quantity) is configured PER CUSTOMER ACCOUNT:
 *
 *   MSIL                            → never any MOQ restriction
 *   Customer + MOQ Not Applicable   → no MOQ restriction
 *   Customer + MOQ Applicable       → the configured MOQ is enforced
 *
 * MUST MATCH backend/utils/moq.js. The server is the authority — it rejects a
 * quantity that breaks the customer's MOQ — and this file exists so the
 * customer is told before they submit, not after. When the two disagree the
 * client either blocks a quantity the server would have accepted (which is how
 * MSIL customers ended up being stopped by MOQ) or offers one it will reject.
 *
 * THE RULE IS A MULTIPLE, NOT A MINIMUM. The quantity must be a whole multiple
 * of the Multiple in force (decided 2026-10-19). The Multiple is the CUSTOMER's
 * configured `moqValue` when they have one, and the product's `moq` otherwise.
 */

/**
 * The per-customer configuration, mirroring `User.moqMode`.
 *
 * NULL IS NOT A THIRD MODE: it means "never configured", and such an account is
 * read through `legacyMode()` below — exactly the behaviour it had before the
 * field existed.
 */
export const MOQ_MODES = {
  APPLICABLE: "APPLICABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
};

/** Read a submitted mode into one of the two canonical values, or null. */
export const normaliseMoqMode = (value) => {
  const v = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "APPLICABLE" || v === "MOQ_APPLICABLE") return MOQ_MODES.APPLICABLE;
  if (v === "NOT_APPLICABLE" || v === "MOQ_NOT_APPLICABLE" || v === "NA" || v === "N_A") {
    return MOQ_MODES.NOT_APPLICABLE;
  }
  return null;
};

/**
 * True when this user is an MSIL customer, and therefore MOQ-exempt.
 *
 * Tolerant of case and whitespace for the same reason the server is: the field
 * is populated by admin data entry and sheet imports, and 'MSIL ' is the same
 * customer as 'MSIL'.
 */
export const isMsilCustomer = (user) =>
  String(user?.customerCategory ?? "").trim().toUpperCase() === "MSIL";

/**
 * Shraddha Impex's own people, identified by their company email domain.
 *
 * MOQ is a rule for CUSTOMERS, so it does not apply to staff ordering through
 * the portal. Matched on the full "@domain" suffix so that
 * `someone@notshraddhaimpex.net` is not read as staff.
 *
 * MUST MATCH backend/utils/moq.js.
 */
export const COMPANY_EMAIL_DOMAIN = "@shraddhaimpex.net";

export const isCompanyUser = (user) =>
  String(user?.email ?? "").trim().toLowerCase().endsWith(COMPANY_EMAIL_DOMAIN);

/** The legacy per-user override on the account, honoured by the server too. */
const hasSkipOverride = (user) =>
  String(user?.moq ?? "").trim().toUpperCase() === "SKIP";

/** What an account with NO stored `moqMode` means — the pre-field rule. */
export const legacyMode = (user) =>
  isMsilCustomer(user) || isCompanyUser(user) || hasSkipOverride(user)
    ? MOQ_MODES.NOT_APPLICABLE
    : MOQ_MODES.APPLICABLE;

/**
 * The MOQ mode in force for this account. The ACCOUNT TYPE wins over the
 * stored configuration, so an MSIL account reads as exempt even if a stale
 * `moqMode` is sitting on it.
 */
export const moqModeOf = (user) => {
  if (isMsilCustomer(user) || isCompanyUser(user) || hasSkipOverride(user)) {
    return MOQ_MODES.NOT_APPLICABLE;
  }
  return normaliseMoqMode(user?.moqMode) ?? legacyMode(user);
};

/** Whether MOQ validation applies to this user at all. */
export const moqAppliesTo = (user) => moqModeOf(user) === MOQ_MODES.APPLICABLE;

/**
 * The customer's own Multiple, when the admin has configured one; else null.
 *
 * A configured 1 is NOT the same as a blank: blank defers to the product, 1 is
 * an admin saying "any quantity for this customer". MUST MATCH the server.
 */
export const customerMoqValue = (user) => {
  const n = Number(user?.moqValue);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The MOQ in force for this user/product pair, or 0 when none applies — a
 * Multiple of 0 or 1 restricts nothing, so it is never shown or mentioned.
 */
export const effectiveMoq = (user, product) => {
  if (!moqAppliesTo(user)) return 0;
  const moq = customerMoqValue(user) ?? (Number(product?.moq) || 0);
  return moq > 1 ? moq : 0;
};

/**
 * The quantity must be a MULTIPLE of the Multiple in force.
 * Mirrors backend/utils/moq.js, which is what the server enforces.
 *
 * @returns {string|null} the error message, or null when the quantity is fine.
 */
export const moqError = (user, product, quantity) => {
  const multiple = effectiveMoq(user, product);
  if (multiple === 0) return null;
  const q = Number(quantity);
  if (Number.isInteger(q) && q > 0 && q % multiple === 0) return null;
  return `Quantity must be a multiple of ${multiple} (e.g. ${multiple}, ${multiple * 2}, ${multiple * 3}).`;
};

/** Is `quantity` allowed under a Multiple? (0 or 1 restricts nothing.) */
export const isMultipleOf = (quantity, multiple) => {
  const q = Number(quantity);
  const m = Number(multiple) || 0;
  return Number.isInteger(q) && q > 0 && (m <= 1 || q % m === 0);
};

export default {
  MOQ_MODES, normaliseMoqMode, legacyMode, moqModeOf, customerMoqValue,
  isMsilCustomer, isCompanyUser, COMPANY_EMAIL_DOMAIN,
  moqAppliesTo, effectiveMoq, moqError, isMultipleOf,
};
