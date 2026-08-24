/**
 * Customer category and MOQ — the client half of one rule.
 *
 * MOQ (Minimum Order Quantity) applies to non-MSIL customers ONLY. MSIL
 * customers are exempt: no MOQ column, no MOQ hint, no MOQ validation.
 *
 * MUST MATCH backend/utils/moq.js. The server is the authority — it rejects a
 * quantity below the MOQ for a non-MSIL customer — and this file exists so the
 * customer is told before they submit, not after. When the two disagree the
 * client either blocks a quantity the server would have accepted (which is how
 * MSIL customers ended up being stopped by MOQ) or offers one it will reject.
 *
 * THE RULE IS A MINIMUM, NOT A PACK SIZE. The quantity must be AT LEAST the
 * MOQ; any amount at or above it is allowed. This screen previously also
 * demanded a whole multiple of the MOQ, which the server has never enforced —
 * so a non-MSIL customer could bulk-upload 150 against an MOQ of 100 and have
 * it accepted, then be refused the identical quantity when typing it by hand.
 */

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

/** Whether MOQ validation applies to this user at all. */
export const moqAppliesTo = (user) => {
  if (isMsilCustomer(user)) return false;
  // Shraddha Impex staff — MOQ constrains customers, not our own people.
  if (isCompanyUser(user)) return false;
  // The per-user 'SKIP' override on the account, honoured by the server too.
  if (String(user?.moq ?? "").trim().toUpperCase() === "SKIP") return false;
  return true;
};

/**
 * The MOQ in force for this user/product pair, or 0 when none applies — an MOQ
 * of 0 or 1 restricts nothing, so it is never shown or mentioned.
 */
export const effectiveMoq = (user, product) => {
  if (!moqAppliesTo(user)) return 0;
  const moq = Number(product?.moq) || 0;
  return moq > 1 ? moq : 0;
};

/** @returns {string|null} the error message, or null when the quantity is fine. */
export const moqError = (user, product, quantity) => {
  const moq = effectiveMoq(user, product);
  if (moq === 0) return null;
  if (Number(quantity) >= moq) return null;
  return `Quantity must be at least the MOQ (${moq})`;
};

export default {
  isMsilCustomer, isCompanyUser, COMPANY_EMAIL_DOMAIN,
  moqAppliesTo, effectiveMoq, moqError,
};
