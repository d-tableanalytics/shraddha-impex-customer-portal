import Order from '../models/Order.js';
import User from '../models/User.js';
import { COMPANY_CC, stripBlocked } from './mailRecipients.js';

/**
 * Who is copied on a mail about a booking.
 *
 * Every customer-facing booking mail copies the customer's own Cc list and the
 * company addresses (COMPANY_CC, which carries the always-copy mailbox). A
 * booking placed by a Sales Person or Admin on the customer's behalf copies
 * that person as well, on EVERY mail in the booking's life — confirmation,
 * quantity changes, PO, status, schedule, expiry — so they can follow what
 * they set in motion without the customer forwarding it.
 *
 * The creator is read from the `createdByEmail` snapshot on the Order rows:
 * the booking record says who placed it, and that is the record the mail is
 * about. The mailer de-duplicates against the To: address and drops blocked
 * entries, so nothing here has to.
 */

const lower = (a) => String(a ?? '').trim().toLowerCase();

const dedupe = (addresses) => {
  const seen = new Set();
  return addresses.filter((a) => {
    const key = lower(a);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The staff address(es) stamped on these Order rows, if any. Sync. */
export const creatorEmails = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [rows];
  return stripBlocked(dedupe(list.map((r) => r?.createdByEmail).filter(Boolean)));
};

/**
 * The full Cc list for a mail to `customer` about these rows.
 *
 * Replaces the `[...bookingCcEmails, ...COMPANY_CC]` every call site used to
 * assemble by hand, with the creator added. Rows are optional — a mail with
 * no booking behind it (a selection-list reminder) just gets the old list.
 */
export const bookingCc = (customer, rows = [], extra = []) => dedupe([
  ...(customer?.bookingCcEmails || []),
  ...COMPANY_CC,
  ...creatorEmails(rows),
  ...(Array.isArray(extra) ? extra : [extra]).filter(Boolean),
]);

/**
 * The creator of a booking, looked up by id for the paths that have no rows
 * in hand (the indent auto-booking, the delivery schedule). One query.
 */
export const creatorEmailsForOrder = async (orderId) => {
  if (!orderId) return [];
  const row = await Order.findOne({ orderId, createdByEmail: { $ne: null } }, 'createdByEmail').lean();
  return creatorEmails(row ? [row] : []);
};

/**
 * The staff who raised these indent lines on the customer's behalf.
 *
 * An indent remembers who reserved it (`reservedBy`); when that is not the
 * customer, it was the booking desk, and their address is copied on the
 * indent's own mails (material inward, auto-booking) the same way it is on the
 * booking's. Read live from the staff account — an indent carries no snapshot.
 */
export const creatorEmailsForIndents = async (reservations = []) => {
  const staffIds = [...new Set(
    reservations
      .filter((r) => r?.reservedBy && r?.customerId
        && String(r.reservedBy?._id ?? r.reservedBy) !== String(r.customerId?._id ?? r.customerId))
      .map((r) => String(r.reservedBy?._id ?? r.reservedBy)),
  )];
  if (!staffIds.length) return [];
  const staff = await User.find({ _id: { $in: staffIds } }, 'email').lean();
  return stripBlocked(dedupe(staff.map((s) => s.email).filter(Boolean)));
};

export default { creatorEmails, bookingCc, creatorEmailsForOrder, creatorEmailsForIndents };
