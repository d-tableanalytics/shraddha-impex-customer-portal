/**
 * Company address copied on customer-facing booking mail, so Shraddha Impex
 * keeps a record of every confirmation and PO.
 *
 * Override via BOOKING_CC_EMAILS in .env (comma-separated) to change or add
 * addresses without touching code. Set it to an empty string to disable.
 */
const list = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const COMPANY_CC = list(process.env.BOOKING_CC_EMAILS ?? 'Contact@shraddhaimpex.net');

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
export const SUPPORT_TEAM = process.env.SUPPORT_TEAM_EMAILS !== undefined
  ? list(process.env.SUPPORT_TEAM_EMAILS)
  : [...COMPANY_CC];

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

export default { COMPANY_CC, SUPPORT_TEAM, supportRecipients };
