/**
 * Company address copied on customer-facing booking mail, so Shraddha Impex
 * keeps a record of every confirmation and PO.
 *
 * Override via BOOKING_CC_EMAILS in .env (comma-separated) to change or add
 * addresses without touching code. Set it to an empty string to disable.
 */
export const COMPANY_CC = (process.env.BOOKING_CC_EMAILS ?? 'Contact@shraddhaimpex.net')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export default { COMPANY_CC };
