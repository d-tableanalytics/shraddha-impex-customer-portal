/**
 * Customer category and MOQ — the single place both rules are decided.
 *
 * MOQ (Minimum Order Quantity) is configured PER CUSTOMER ACCOUNT. There are
 * two account types and, for one of them, a configuration:
 *
 *   MSIL                            → never any MOQ restriction
 *   Customer + MOQ Not Applicable   → no MOQ restriction
 *   Customer + MOQ Applicable       → the configured MOQ is enforced
 *
 * WHY THIS LIVES IN ONE FILE. The rule was previously re-typed at each call
 * site as `user.customerCategory !== 'MSIL'`. Every copy was correct in
 * isolation and the set of them was not: a category stored as 'msil' or with a
 * stray space — which is what a spreadsheet import produces — failed the exact
 * comparison, so the customer was silently reclassified as Customer and had MOQ
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
 * ── THE PER-CUSTOMER CONFIGURATION ──────────────────────────────────────────
 *
 * `User.moqMode` holds one of these, or null.
 *
 * NULL IS NOT A THIRD MODE. It means "never configured", which is the state
 * every account that existed before this field did is in. An unconfigured
 * account is read through `legacyMode()` below, which reproduces exactly the
 * behaviour it had yesterday — that is what makes the migration safe whether or
 * not the backfill script has been run against a given database.
 */
export const MOQ_MODES = {
  APPLICABLE: 'APPLICABLE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

/**
 * Read a submitted mode into one of the two canonical values, or null.
 *
 * Tolerant of case, spacing and the spellings the UI and an integration are
 * each likely to send ('Not Applicable', 'NOT_APPLICABLE'), for the same reason
 * the category check below is: these values arrive from admin data entry.
 * Anything it does not recognise comes back as null, and the write paths refuse
 * a null they were explicitly sent rather than storing a guess.
 */
export const normaliseMoqMode = (value) => {
  const v = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (v === 'APPLICABLE' || v === 'MOQ_APPLICABLE') return MOQ_MODES.APPLICABLE;
  if (v === 'NOT_APPLICABLE' || v === 'MOQ_NOT_APPLICABLE' || v === 'NA' || v === 'N_A') {
    return MOQ_MODES.NOT_APPLICABLE;
  }
  return null;
};

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
 * The legacy per-user override on the account (`User.moq`), which predates
 * `moqMode` and is still how a specific Customer account was exempted by hand.
 */
const hasSkipOverride = (user) =>
  String(user?.moq ?? '').trim().toUpperCase() === 'SKIP';

/**
 * What an account with NO stored `moqMode` means.
 *
 * This is the rule as it stood before the field existed, written out so the
 * backfill script and the runtime cannot disagree about what an unconfigured
 * account was doing: MSIL exempt, staff exempt, a 'SKIP' override exempt, and
 * everybody else subject to the product's Multiple.
 */
export const legacyMode = (user) => (
  isMsilCustomer(user) || isCompanyUser(user) || hasSkipOverride(user)
    ? MOQ_MODES.NOT_APPLICABLE
    : MOQ_MODES.APPLICABLE
);

/**
 * The MOQ mode in force for this account.
 *
 * The ACCOUNT TYPE wins over the stored configuration, deliberately and in both
 * directions of the data: an MSIL account reads as exempt even if a stale
 * `moqMode: 'APPLICABLE'` is sitting on it from before it was switched to MSIL.
 * The write paths keep the two in step (see user.controller.js), and this makes
 * the rule true regardless of whether they ever ran.
 */
export const moqModeOf = (user) => {
  if (isMsilCustomer(user) || isCompanyUser(user) || hasSkipOverride(user)) {
    return MOQ_MODES.NOT_APPLICABLE;
  }
  return normaliseMoqMode(user?.moqMode) ?? legacyMode(user);
};

/** Whether MOQ validation runs for this user at all. */
export const moqAppliesTo = (user) => moqModeOf(user) === MOQ_MODES.APPLICABLE;

/**
 * The customer's OWN Multiple, when the admin has configured one.
 *
 * A positive whole number here replaces the product's `moq` for this customer.
 * Null means "use the product's", which is what an account configured as MOQ
 * Applicable without a value does — and what every account did before this
 * field existed, so leaving it blank is the backward-compatible choice as well
 * as the common one.
 *
 * A configured 1 is NOT the same as a blank. Blank defers to the product; 1 is
 * an admin saying "any quantity for this customer", and `effectiveMoq` honours
 * it as the no-restriction value it literally is rather than overruling a
 * deliberate choice with the product's number.
 */
export const customerMoqValue = (user) => {
  const n = Number(user?.moqValue);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  const moq = customerMoqValue(user) ?? (Number(product?.moq) || 0);
  return moq > 1 ? moq : 0;
};

/**
 * The rule: the quantity must be a MULTIPLE of the Multiple in force (the
 * product's field is still called `moq` in the data; a customer-level value
 * overrides it). With a Multiple of 10, 10, 20 and 30 are allowed; 15 is not.
 * Decided 2026-10-19 — before then it was a minimum ("at least the MOQ"), and
 * the label shown everywhere changed from MOQ to Multiple at the same time.
 *
 * @returns {string|null} the error message, or null when the quantity is fine.
 */
export const moqError = (user, product, quantity) => {
  const multiple = effectiveMoq(user, product);
  if (multiple === 0) return null;
  const q = Number(quantity);
  if (Number.isInteger(q) && q > 0 && q % multiple === 0) return null;
  return `Quantity must be a multiple of ${multiple}`
    + (product?.skuCode ? ` for ${product.skuCode}` : '')
    + ` (e.g. ${multiple}, ${multiple * 2}, ${multiple * 3}).`;
};

/** Throwing form, for the request paths that surface an Error to the client. */
export const enforceMoq = (user, product, quantity) => {
  const message = moqError(user, product, quantity);
  if (message) throw new Error(message);
};

/**
 * The account's MOQ configuration, for an API response or an audit line.
 *
 * `source` says whether the answer came from the stored configuration or from
 * the legacy derivation, which is what makes "this customer has never been
 * configured" visible rather than indistinguishable from "configured the same
 * way by hand".
 */
export const moqConfigFor = (user) => ({
  accountType: isMsilCustomer(user) ? 'MSIL' : 'Customer',
  mode: moqModeOf(user),
  value: customerMoqValue(user),
  applies: moqAppliesTo(user),
  source: normaliseMoqMode(user?.moqMode) ? 'configured' : 'derived',
});

export default {
  MOQ_MODES, normaliseMoqMode, legacyMode, moqModeOf, customerMoqValue, moqConfigFor,
  isMsilCustomer, isCompanyUser, COMPANY_EMAIL_DOMAIN,
  moqAppliesTo, effectiveMoq, moqError, enforceMoq,
};
