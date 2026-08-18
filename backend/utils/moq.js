/**
 * Customer category and MOQ — the single place both rules are decided.
 *
 * MOQ (Minimum Order Quantity) applies to Non-MSIL customers ONLY. MSIL
 * customers are exempt and must never be stopped by it.
 *
 *   IF customer = MSIL      → no MOQ validation at all
 *   IF customer ≠ MSIL      → the configured MOQ is enforced
 *
 * WHY THIS LIVES IN ONE FILE. The rule was previously re-typed at each call
 * site as `user.customerCategory !== 'MSIL'`. Every copy was correct in
 * isolation and the set of them was not: a category stored as 'msil' or with a
 * stray space — which is what a spreadsheet import produces — failed the exact
 * comparison, so the customer was silently reclassified as Non-MSIL and had MOQ
 * enforced against them. That is the reported defect, and it cannot be fixed by
 * correcting one call site. Classification is therefore derived here, once,
 * tolerantly, and every flow (individual booking, quantity edit, bulk upload,
 * sales desk) asks this module rather than re-deriving it.
 *
 * MUST MATCH frontend/src/utils/moq.js — the client hides and pre-validates
 * MOQ using the same rule, and a client that disagrees with the server either
 * blocks a quantity the server would accept or offers one it will reject.
 */

/**
 * True when this user is an MSIL customer, and therefore MOQ-exempt.
 *
 * Tolerant of case and surrounding whitespace on purpose — the field is
 * populated by admin data entry and by sheet imports, and 'MSIL ' is the same
 * customer as 'MSIL'.
 */
export const isMsilCustomer = (user) =>
  String(user?.customerCategory ?? '').trim().toUpperCase() === 'MSIL';

/**
 * Shraddha Impex's own people, identified by their company email domain.
 *
 * MOQ is a rule for CUSTOMERS. Staff ordering through the portal — sales
 * raising a booking on someone's behalf, anyone testing a flow — are not the
 * party the minimum exists to constrain, so it does not apply to them.
 *
 * Matched on the full "@domain" suffix, never a bare "shraddhaimpex.net"
 * substring: the leading @ is what stops `someone@notshraddhaimpex.net` from
 * being read as staff. A subdomain such as `a@mail.shraddhaimpex.net` is
 * deliberately NOT matched — it is a different mail domain, and quietly
 * exempting it would be a guess.
 *
 * Case and whitespace tolerant for the same reason the category check is:
 * the field is filled by admin data entry and sheet imports.
 */
export const COMPANY_EMAIL_DOMAIN = '@shraddhaimpex.net';

export const isCompanyUser = (user) =>
  String(user?.email ?? '').trim().toLowerCase().endsWith(COMPANY_EMAIL_DOMAIN);

/**
 * Whether MOQ validation runs for this user at all.
 *
 * Three ways out: being an MSIL customer, being Shraddha Impex staff (company
 * email domain), and the per-user 'SKIP' override on the account (User.moq),
 * which predates the category field and is still how a specific Non-MSIL
 * account is exempted by hand.
 */
export const moqAppliesTo = (user) => {
  if (isMsilCustomer(user)) return false;
  if (isCompanyUser(user)) return false;
  if (String(user?.moq ?? '').trim().toUpperCase() === 'SKIP') return false;
  return true;
};

/**
 * The MOQ in force for this user/product pair, or 0 when none applies.
 *
 * An MOQ of 0 or 1 is not a restriction — every whole-number quantity of at
 * least 1 satisfies it — so it is reported as "no MOQ" and no message about it
 * is ever shown.
 */
export const effectiveMoq = (user, product) => {
  if (!moqAppliesTo(user)) return 0;
  const moq = Number(product?.moq) || 0;
  return moq > 1 ? moq : 0;
};

/**
 * The agreed rule: the quantity must be AT LEAST the MOQ. Any amount at or
 * above it is allowed — it is a minimum, not a pack size, so no multiple-of
 * check belongs here.
 *
 * @returns {string|null} the error message, or null when the quantity is fine.
 */
export const moqError = (user, product, quantity) => {
  const moq = effectiveMoq(user, product);
  if (moq === 0) return null;
  if (Number(quantity) >= moq) return null;
  return `Quantity must be at least the Minimum Order Quantity (${moq})`
    + (product?.skuCode ? ` for ${product.skuCode}.` : '.');
};

/** Throwing form, for the request paths that surface an Error to the client. */
export const enforceMoq = (user, product, quantity) => {
  const message = moqError(user, product, quantity);
  if (message) throw new Error(message);
};

export default {
  isMsilCustomer, isCompanyUser, COMPANY_EMAIL_DOMAIN,
  moqAppliesTo, effectiveMoq, moqError, enforceMoq,
};
