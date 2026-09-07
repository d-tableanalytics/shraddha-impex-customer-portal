/**
 * The mail half of an inbox notification.
 *
 * ---------------------------------------------------------------------------
 * A thin adapter, not a second mail stack
 * ---------------------------------------------------------------------------
 * The reference builds its own nodemailer transport inside `InboxModule`
 * (`mail.service.ts`), giving the application two independent mailers. This
 * portal already has one — `utils/mailer.js` — with a recipient blocklist, a
 * dev simulator for an unset `SMTP_HOST`, and a shell every portal mail shares.
 * Duplicating it would mean two transports, two configurations and two places
 * for a blocklist to be forgotten.
 *
 * So this is an adapter: it decides WHO to mail and renders WHAT to say, and
 * hands both to the existing sender.
 *
 * ---------------------------------------------------------------------------
 * Off unless switched on
 * ---------------------------------------------------------------------------
 * `HRMS_MAIL_ENABLED` gates the whole thing, and defaults to OFF. Outbound mail
 * is the one HRMS behaviour that reaches people who are not looking at the
 * application, cannot be recalled, and lands in mailboxes this system does not
 * control. That is a deployment decision, not a code default — and it means the
 * inbox works identically whether or not anybody has configured SMTP.
 *
 * ---------------------------------------------------------------------------
 * Never throws, never blocks
 * ---------------------------------------------------------------------------
 * The reference's own comment says it: "a Mailpit hiccup shouldn't fail a leave
 * request". `sendEmail` already swallows transport errors and returns false;
 * everything else here is inside the notifier's catch. A notification is a
 * courtesy on top of a fact that is already recorded.
 */

import Employee from '../../../models/hrms/Employee.js';
import User from '../../../models/User.js';
import { sendEmail } from '../../../utils/mailer.js';
import { HRMS_ROUTE_PREFIX } from '../../../shared/constants/hrms.js';
import { hrefFor } from '../../../shared/constants/inbox.js';
import { renderInboxMail, hasMailTemplate } from './mailTemplates.js';

/**
 * Read at call time rather than at import, so a test can set it per case and so
 * a deployment does not depend on module load order.
 */
export const mailEnabled = () =>
  String(process.env.HRMS_MAIL_ENABLED ?? '').toLowerCase() === 'true';

/**
 * Work addresses for a set of employees.
 *
 * Resolved through the Employee → User link, server-side. No caller supplies an
 * address, so an inbox event cannot be made to mail somebody it was not
 * addressed to. An employee with no user account simply gets no mail — their
 * inbox row is still written, which is the point of the inbox being the
 * primary channel and mail the secondary one.
 */
async function addressesFor(employeeIds) {
  if (employeeIds.length === 0) return [];

  const employees = await Employee.find({ _id: { $in: employeeIds }, deletedAt: null })
    .select('userId')
    .lean();

  const userIds = employees.map((e) => e.userId).filter(Boolean);
  if (userIds.length === 0) return [];

  const users = await User.find({ _id: { $in: userIds }, status: 'Active' })
    .select('email')
    .lean();

  return [...new Set(users.map((u) => u.email).filter(Boolean))];
}

/**
 * Mail an inbox event to the people it was filed for.
 *
 * Called by `notify()` AFTER the rows are written, so mail is never the reason
 * a notification is missing. Returns how many were sent, for the tests.
 *
 * @param {object} input
 * @param {string} input.type          an INBOX_TYPES value
 * @param {string} input.title         the same line the inbox row shows
 * @param {ObjectId[]} input.recipients employee ids, already resolved and live
 */
export async function sendInboxMail({ type, title, recipients = [] }) {
  // Three gates, cheapest first: switched off, no template for this event, or
  // nobody to tell. Most events fall out at the second — being an inbox item
  // does not make something worth an email.
  if (!mailEnabled()) return 0;
  if (!hasMailTemplate(type)) return 0;
  if (recipients.length === 0) return 0;

  const rendered = renderInboxMail(type, {
    title,
    // The same derived link the inbox row carries — never a stored href.
    href: `${process.env.APP_BASE_URL ?? ''}${hrefFor(type, HRMS_ROUTE_PREFIX)}`,
  });
  if (!rendered) return 0;

  const addresses = await addressesFor(recipients);

  let sent = 0;
  for (const to of addresses) {
    // One mail per person. Never a shared To or Cc line: an approver list on a
    // resignation would disclose to each recipient who else was told.
    const ok = await sendEmail(to, rendered.subject, rendered.html);
    if (ok !== false) sent += 1;
  }
  return sent;
}

export default { sendInboxMail, mailEnabled };
