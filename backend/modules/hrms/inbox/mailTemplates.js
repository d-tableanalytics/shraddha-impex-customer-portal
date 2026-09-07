/**
 * Transactional mail for inbox events.
 *
 * ---------------------------------------------------------------------------
 * What the reference sends, and what these deliberately do not
 * ---------------------------------------------------------------------------
 * `modules/inbox/mail-templates.ts` holds twelve templates; nine are called
 * outside Operations. Seven of those correspond to an inbox event an employee
 * receives, and are reproduced here. Two are not:
 *
 *   `employment.confirmation`  an Employees-module send with a signed letter
 *                              attached. Not an inbox producer, so not here.
 *   `offer.sent` (Hiring)      goes to an external CANDIDATE, addressed by the
 *                              public offer token. That flow lives in Hiring's
 *                              careers surface and has no inbox item at all.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Four of the reference's templates carry data that must not leave
 * ---------------------------------------------------------------------------
 * SMTP is cleartext to an inbox the company does not control, retained
 * indefinitely, and forwarded without any of this system's authorisation. What
 * the reference puts in it:
 *
 *   `leave.pending`                 `Reason: ${v.reason}` — why somebody wants
 *                                   time off, in their own words. Medical and
 *                                   bereavement leave both go through here.
 *   `attendance.correction.pending` the same, for a correction.
 *   `exit.initiated`                `Reason: ${v.reason}` — why an employee is
 *                                   resigning, mailed to their manager AND HR.
 *   `expense.pending`               the claim total, in the SUBJECT LINE:
 *                                   "submitted an expense claim (₹1,23,456.00)"
 *                                   — readable in a notification preview on a
 *                                   lock screen.
 *
 * None of it is needed to act. The recipient is an authorised user of a system
 * that will show them the whole record; the mail's job is to say that something
 * is waiting and where. So every template below carries WHO, WHAT KIND and a
 * LINK, and nothing a reader could not already see.
 *
 * That is the same rule the inbox bodies follow, applied one step further out —
 * an inbox row at least stays inside the authorisation boundary.
 */

import { INBOX_TYPES, labelOf } from '../../../shared/constants/inbox.js';

/** HTML-escape every interpolated value. A name is user-controlled text. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * The body, wrapped by `utils/mailer.js`'s own shell.
 *
 * The portal's mailer already supplies the outer table, the branding and the
 * footer — this is the inner block only, which is why there is no `<html>` here
 * and why a second nodemailer transport was not created.
 */
function block({ heading, lines = [], cta, href }) {
  // `heading`, `cta` and `href` arrive RAW and are escaped here. `lines` are
  // HTML fragments the caller has already escaped — passing an escaped heading
  // in as well would double-encode it, so `<` reached the reader as `&amp;lt;`.
  const paragraphs = lines.filter(Boolean).map((l) => `<p style="margin:0 0 10px">${l}</p>`);

  return `
    <p style="font-size:15px;font-weight:600;margin:0 0 12px">${esc(heading)}</p>
    ${paragraphs.join('\n')}
    ${
      cta && href
        ? `<p style="margin:18px 0 0"><a href="${esc(href)}" style="display:inline-block;padding:10px 16px;background:#1a5b9e;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${esc(cta)}</a></p>`
        : ''
    }
  `.trim();
}

const T = INBOX_TYPES;

/**
 * One template per inbox type that warrants a mail.
 *
 * A type ABSENT from this map is an inbox item and nothing more — which is the
 * default. Adding a key here is the whole decision to start emailing an event,
 * so the list is deliberately short and deliberately explicit.
 *
 * Each returns `{ subject, html }`. `vars` carries only what the notifier
 * already had: the recipient's name, the title the inbox row is showing, and
 * the derived link.
 */
export const MAIL_TEMPLATES = Object.freeze({
  // --- Leave -------------------------------------------------------------
  [T.LEAVE_PENDING]: ({ title, href }) => ({
    subject: 'A leave request is awaiting your approval',
    html: block({
      heading: 'A leave request needs your decision',
      // 🔴 The reason is NOT here. The reference mails it.
      lines: [esc(title), 'Open the request to see the full details and decide.'],
      cta: 'Review request',
      href,
    }),
  }),

  [T.LEAVE_DECIDED]: ({ title, href }) => ({
    subject: 'Your leave request has been decided',
    html: block({
      heading: title,
      lines: ['Open your leave history for the details.'],
      cta: 'Open in HRMS',
      href,
    }),
  }),

  // --- Attendance --------------------------------------------------------
  [T.ATTENDANCE_CORRECTION_PENDING]: ({ title, href }) => ({
    subject: 'An attendance correction is awaiting your approval',
    html: block({
      heading: 'An attendance correction needs your decision',
      // 🔴 The reason is NOT here. The reference mails it.
      lines: [esc(title), 'Open the request to see what is being corrected and decide.'],
      cta: 'Review request',
      href,
    }),
  }),

  [T.ATTENDANCE_CORRECTION_DECIDED]: ({ title, href }) => ({
    subject: 'Your attendance correction has been decided',
    html: block({
      heading: title,
      lines: ['Open your corrections list for the details.'],
      cta: 'Open in HRMS',
      href,
    }),
  }),

  // --- Expenses ----------------------------------------------------------
  [T.EXPENSE_PENDING]: ({ title, href }) => ({
    // 🔴 The reference puts the claim TOTAL in this subject line, where it is
    // readable in a phone's notification preview without unlocking anything.
    subject: 'An expense claim is awaiting your approval',
    html: block({
      heading: 'An expense claim needs your decision',
      lines: [esc(title), 'Open the claim to see the amount, the lines and the receipts.'],
      cta: 'Review claim',
      href,
    }),
  }),

  // --- Exits -------------------------------------------------------------
  [T.EXIT_INITIATED]: ({ title, href }) => ({
    subject: 'An exit request needs your attention',
    html: block({
      heading: title,
      // 🔴 The reference mails the resignation REASON to the manager and HR.
      lines: ['Open the exit request for the details and the next step.'],
      cta: 'Open exit request',
      href,
    }),
  }),

  // --- Onboarding --------------------------------------------------------
  [T.OFFER_LETTER_READY]: ({ href }) => ({
    subject: 'Your offer letter is ready',
    html: block({
      heading: 'Your offer letter is ready to review',
      lines: ['Sign in to the portal to read it and sign electronically.'],
      cta: 'Open portal',
      href,
    }),
  }),
});

/** Whether an inbox type is one this system emails at all. */
export const hasMailTemplate = (type) => Object.hasOwn(MAIL_TEMPLATES, type);

/**
 * Render one, or null if the type is inbox-only.
 *
 * Pure and dependency-free so the generated subject and body can be asserted in
 * a test without a transport, a network or an SMTP server.
 */
export function renderInboxMail(type, vars = {}) {
  const template = MAIL_TEMPLATES[type];
  if (!template) return null;

  const rendered = template({
    title: vars.title ?? labelOf(type),
    href: vars.href ?? '',
  });

  return { subject: rendered.subject, html: rendered.html };
}

export default { MAIL_TEMPLATES, hasMailTemplate, renderInboxMail };
