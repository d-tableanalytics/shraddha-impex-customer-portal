/**
 * WHO a booking is for, and who placed it — one rule for every desk screen.
 *
 * The Sales Desk list, the booking drawer it opens and the exports all show
 * the same three facts, and they used to source them differently: the list
 * read the customer's live profile while the drawer's "Customer" tile showed
 * `booking.customer`, which is the COMPANY stamped on the order rows. Two
 * screens disagreeing about the same booking is what this module stops.
 *
 *   customerNameOf  the Customer Master name, else the CONTACT person, else
 *                   nothing. NEVER the company — that rule is pinned by
 *                   `pages/SalesDesk/salesDeskCustomer.test.js`, and by
 *                   `services/customerName.test.js` for Booking History: two
 *                   customers at one company must stay distinguishable.
 *   companyNameOf   the customer's CURRENT company from their profile, else
 *                   the company stamped on the booking (the only value left
 *                   once the account is deleted).
 *   siTeamOf        the Sales Person or Admin who placed the booking on the
 *                   customer's behalf, as STORED on the booking when it was
 *                   made (`createdBy`, see backend models/Order.js) — never
 *                   the signed-in user. Null for the customer's own booking.
 *
 * `customerProfile` is attached by the server on every booking response, read
 * live from the customer's user record (utils/customerContact.js), so a master
 * detail filled in after the booking was placed shows on it immediately.
 */

export const customerNameOf = (booking) =>
  booking?.customerProfile?.customerName
  || booking?.customerProfile?.contactName
  || null;

export const companyNameOf = (booking) =>
  booking?.customerProfile?.company || booking?.customer || null;

export const siTeamOf = (booking) => booking?.createdBy?.name || null;

/** "Sales Person A (Sales)" for a tooltip; null for the customer's own booking. */
export const siTeamLabelOf = (booking) => {
  const name = siTeamOf(booking);
  if (!name) return null;
  const role = booking?.createdBy?.role;
  return role ? `${name} (${role})` : name;
};

export default { customerNameOf, companyNameOf, siTeamOf, siTeamLabelOf };
