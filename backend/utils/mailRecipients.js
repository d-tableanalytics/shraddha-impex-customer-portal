const list = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Addresses that must never receive portal mail, whatever a customer record,
 * spreadsheet import or .env says. These two arrived through the 'Booking CC
 * Emails' column of the migration sheet and were being copied on live customer
 * mail; deleting them from the database alone is not enough, because the next
 * re-import of the same sheet puts them straight back.
 *
 * Add to the list via BLOCKED_EMAILS in .env (comma-separated).
 */
export const BLOCKED_RECIPIENTS = new Set(
  [
    'pankajkannavedia@dtableanalytics.com',
    'krishnapawar@dtableanalytics.com',
    ...list(process.env.BLOCKED_EMAILS),
  ].map((a) => a.toLowerCase()),
);

/** True when the address is on the blocklist. Case- and space-insensitive. */
export const isBlockedRecipient = (address) =>
  BLOCKED_RECIPIENTS.has(String(address ?? '').trim().toLowerCase());

/** Drops every blocked address from a list of recipients. */
export const stripBlocked = (addresses = []) =>
  (Array.isArray(addresses) ? addresses : [addresses]).filter((a) => !isBlockedRecipient(a));

/**
 * Company address copied on customer-facing booking mail, so Shraddha Impex
 * keeps a record of every confirmation and PO.
 *
 * Override via BOOKING_CC_EMAILS in .env (comma-separated) to change or add
 * addresses without touching code. Set it to an empty string to disable.
 */
export const COMPANY_CC = stripBlocked(
  list(process.env.BOOKING_CC_EMAILS ?? 'Contact@shraddhaimpex.net'),
);

/**
 * The Support Team mailbox.
 *
 * Support is a RECIPIENT in its own right, not a Cc on the customer's mail.
 * Cc'ing worked while the only notification was a booking confirmation, but an
 * indent raised with no booking, and material inwarded against an indent, are
 * events support has to act on — and a Cc line on a mail addressed to somebody
 * else is filtered away by every rule anyone has ever written. Sending support
 * its own copy is also what lets the two bodies differ where they must: the
 * customer is told "your indent", support is told which customer it belongs to.
 *
 * Override via SUPPORT_TEAM_EMAILS in .env (comma-separated). It falls back to
 * BOOKING_CC_EMAILS/COMPANY_CC so an environment that has not been given the
 * new variable still reaches a real person rather than silently nobody.
 */
export const SUPPORT_TEAM = stripBlocked(
  process.env.SUPPORT_TEAM_EMAILS !== undefined
    ? list(process.env.SUPPORT_TEAM_EMAILS)
    : [...COMPANY_CC],
);

/**
 * Support's To: address plus any others to copy. Returns null when no support
 * address is configured at all, so callers can skip the send rather than post
 * a mail to an empty recipient list.
 */
export const supportRecipients = () => {
  if (SUPPORT_TEAM.length === 0) return null;
  const [to, ...cc] = SUPPORT_TEAM;
  return { to, cc };
};

export default {
  COMPANY_CC,
  SUPPORT_TEAM,
  supportRecipients,
  BLOCKED_RECIPIENTS,
  isBlockedRecipient,
  stripBlocked,
};
