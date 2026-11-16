import User from '../models/User.js';
import { hasPermission, PERMISSIONS } from '../middlewares/rbac.js';

/**
 * Who a booking is FOR, and who is PLACING it.
 *
 * The booking flow was written for one person: the signed-in customer reserves,
 * confirms, and owns the result. A Sales Person or Admin may now do the same on
 * a customer's behalf from Create Booking, and every write path then has two
 * people in it — the CUSTOMER the booking belongs to (its `user`, its emails,
 * its Booking History) and the ACTOR who pressed the button (the audit trail,
 * the `createdBy` stamp, the "SI Team" column, a Cc on every mail).
 *
 * This module answers that question in one place so the reservation routes
 * cannot disagree about it.
 */

/** The fields the booking paths read off the customer. Never the password. */
const CUSTOMER_FIELDS = 'email user company customerName role status customerCategory phone location '
  + 'shopNumber vendorNumber gstNumber shippingAddress billingAddress brandAccess moq showMsilCode '
  + 'bookingCcEmails preferences';

const refuse = (status, message, code) => {
  const err = new Error(message);
  err.statusCode = status;
  err.status = status;
  if (code) err.code = code;
  return err;
};

const isCustomerAccount = (account) => (account?.role || 'Customer') === 'Customer';

/**
 * Resolve the customer a request books for.
 *
 * No `customerId` (or the caller's own id) is the existing flow, untouched: the
 * signed-in account books for itself. Anything else is a booking ON BEHALF OF
 * that customer, which only the booking desk may do — `view_all_bookings`, the
 * permission that already lets Sales and Admin see and work every customer's
 * bookings. A customer passing somebody else's id is refused outright.
 *
 * The target must be a live Customer account. A staff account is not a
 * customer and cannot own a booking; a suspended or inactive one must not be
 * booked for, because nobody would be able to sign in and see it.
 *
 * @returns {{ customer: object, onBehalf: boolean }}
 *          `customer` is the account the booking is for — the caller's own
 *          `req.user` when booking for themselves, else the loaded User.
 */
export const resolveBookingCustomer = async (req, customerId) => {
  const wanted = customerId == null ? '' : String(customerId).trim();
  if (!wanted || wanted === String(req.user?._id)) {
    return { customer: req.user, onBehalf: false };
  }

  if (!hasPermission(req.user, PERMISSIONS.VIEW_ALL_BOOKINGS)) {
    throw refuse(403, 'You can only create bookings for your own account.', 'NOT_BOOKING_DESK');
  }

  const customer = /^[0-9a-fA-F]{24}$/.test(wanted)
    ? await User.findById(wanted).select(CUSTOMER_FIELDS)
    : null;
  if (!customer) {
    throw refuse(404, 'Customer not found. Select an existing customer from Customer Management.', 'CUSTOMER_NOT_FOUND');
  }
  if (!isCustomerAccount(customer)) {
    throw refuse(400, 'Bookings can only be created for customer accounts.', 'NOT_A_CUSTOMER');
  }
  if (customer.status && customer.status !== 'Active') {
    throw refuse(409, `This customer account is ${customer.status.toLowerCase()}; reactivate it in Customer Management before booking for it.`, 'CUSTOMER_INACTIVE');
  }

  return { customer, onBehalf: true };
};

/**
 * The customer an EXISTING line belongs to, for a desk edit of it.
 *
 * No eligibility checks: the line already exists, so the question is only
 * whose rules (brand, MOQ) apply to it. Falls back to the caller when the
 * account is gone, which keeps a legacy line editable rather than orphaned.
 */
export const loadBookingCustomer = async (req, customerId) => {
  if (!customerId || String(customerId) === String(req.user?._id)) return req.user;
  return (await User.findById(customerId).select(CUSTOMER_FIELDS)) || req.user;
};

/** The display name for a staff account, as the SI Team column prints it. */
export const actorName = (account) =>
  account?.user || account?.customerName || account?.company || account?.email || null;

/**
 * The `createdBy*` stamp for the Order rows of a booking.
 *
 * Only a booking placed on a customer's behalf carries one; the customer's own
 * booking stamps nothing, so "null means the customer" stays true on every row.
 */
export const creatorStamp = (req, onBehalf) => (onBehalf
  ? {
    createdBy: req.user._id,
    createdByName: actorName(req.user),
    createdByEmail: req.user.email || null,
    createdByRole: req.user.role || null,
  }
  : { createdBy: null, createdByName: null, createdByEmail: null, createdByRole: null });

/** Who the customer is, for notifications and audit remarks. */
export const customerLabel = (customer) =>
  customer?.customerName || customer?.user || customer?.company || customer?.email || 'the customer';

export default { resolveBookingCustomer, loadBookingCustomer, creatorStamp, actorName, customerLabel };
