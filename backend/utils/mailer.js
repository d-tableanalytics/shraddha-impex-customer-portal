import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

import { isBlockedRecipient, stripBlocked } from './mailRecipients.js';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});


/**
 * @param {string}   to        Primary recipient.
 * @param {string}   subject
 * @param {string}   htmlBody  Inner HTML — wrapped in the standard shell below.
 * @param {object}  [options]
 * @param {string[]} [options.cc]  Extra addresses to copy (e.g. a user's bookingCcEmails).
 */
// The shell around every notification. Named for the PORTAL, not for one of
// the things it carries: the same portal handles bookings, purchase orders and
// indents, and signing a purchase-order mail as the "Booking Portal" is what
// made those mails read as being about something else.
export const sendEmail = async (to, subject, htmlBody, options = {}) => {
  // Last line of defence for the blocklist: every notification in the app goes
  // through here, so filtering at this point covers call paths that assemble
  // their recipients from a customer record without consulting mailRecipients.
  if (isBlockedRecipient(to)) {
    console.warn(`[Mailer] Skipped — "${to}" is a blocked recipient. Subject: ${subject}`);
    return false;
  }

  // Accept a single string or an array; drop blanks and de-duplicate against `to`.
  const cc = [...new Set(
    stripBlocked(Array.isArray(options.cc) ? options.cc : options.cc ? [options.cc] : [])
      .map((a) => String(a).trim())
      .filter(Boolean)
      .filter((a) => a.toLowerCase() !== String(to).trim().toLowerCase())
  )];

  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.example.com') {
    // A MISSING SMTP_HOST IS NOT A DEV SETTING. Falling back here silently
    // returned true, so an app started without its .env — from the repo root,
    // say, where dotenv finds nothing — reported every notification as
    // delivered while sending none. Say so unmistakably.
    if (!process.env.SMTP_HOST) {
      console.error(
        '[Mailer] SMTP_HOST IS NOT SET — NO MAIL IS BEING SENT. If this is not a '
        + `dev machine the process was started without its .env (cwd: ${process.cwd()}). `
        + `Intended recipient: ${to}`,
      );
    }
    console.log(`\n=== [DEV MAIL SIMULATOR] ===`);
    console.log(`To: ${to}`);
    if (cc.length) console.log(`Cc: ${cc.join(', ')}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: \n${htmlBody}`);
    console.log(`============================\n`);
    return true;
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"Shraddha Impex Portal" <no-reply@example.com>',
      to,
      ...(cc.length ? { cc } : {}),
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #1a5b9e;">Shraddha Impex Portal Notification</h2>
          <div style="border-top: 2px solid #eee; padding-top: 15px; font-size: 14px; line-height: 1.6;">
            ${htmlBody}
          </div>
          <p style="margin-top: 30px; font-size: 12px; color: #777;">
            This is an automated email from the Shraddha Impex Portal. Please do not reply directly to this message.
          </p>
        </div>
      `,
    });
    
    console.log(`[Mailer] Message sent to ${to}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`[Mailer] Failed to send email to ${to}:`, error);
    return false;
  }
};
