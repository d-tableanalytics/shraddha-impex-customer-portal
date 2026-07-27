import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

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
export const sendEmail = async (to, subject, htmlBody, options = {}) => {
  // Accept a single string or an array; drop blanks and de-duplicate against `to`.
  const cc = [...new Set(
    (Array.isArray(options.cc) ? options.cc : options.cc ? [options.cc] : [])
      .map((a) => String(a).trim())
      .filter(Boolean)
      .filter((a) => a.toLowerCase() !== String(to).trim().toLowerCase())
  )];

  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.example.com') {
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
      from: process.env.EMAIL_FROM || '"Shraddha Impex Booking Portal" <no-reply@example.com>',
      to,
      ...(cc.length ? { cc } : {}),
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #1a5b9e;">Shraddha Impex Booking Portal Notification</h2>
          <div style="border-top: 2px solid #eee; padding-top: 15px; font-size: 14px; line-height: 1.6;">
            ${htmlBody}
          </div>
          <p style="margin-top: 30px; font-size: 12px; color: #777;">
            This is an automated email from your Shraddha Impex Booking Portal. Please do not reply directly to this message.
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
