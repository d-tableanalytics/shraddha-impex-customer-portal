import { hasPermission, PERMISSIONS } from '../middlewares/rbac.js';
import { isPoGenerated } from './bookingLock.js';

/**
 * Who sees money on an order row, and how much of it.
 *
 * Three audiences, and they are told three different things:
 *
 *   view_pricing (Admin, Sales, or a role granted it)
 *       Everything. They chose the price and have to be able to check it.
 *
 *   The customer, on THEIR OWN booking, once the PO is raised
 *       The RATE AND NOTHING ELSE. `unitPrice` stays; `priceType`, `pricedAt`
 *       and `pricedBy` are removed. The tier name is internal vocabulary —
 *       telling a customer their line is the "Trader" rate advertises that
 *       other tiers exist and invites the question of what they cost. What was
 *       agreed is a price, so a price is what they are shown.
 *
 *   Everyone else
 *       No money at all. Two separate cases, and both matter:
 *
 *       - The owner BEFORE the PO exists. A price becomes the customer's
 *         business when the purchase order quoting it is raised; until then it
 *         is a working figure at the desk and may still change.
 *
 *       - Somebody else's booking. A role can hold view_all_bookings without
 *         view_pricing — the matrix allows exactly that — and such a reader
 *         gets the booking with no rate on it. Without the ownership test this
 *         is the hole the whole feature leaks through, because every raised PO
 *         carries a rate and the bookings endpoint would hand it over.
 *
 * STRIPPED SERVER-SIDE, like the box number beside it (utils/boxNoVisibility.js)
 * and for the same reason: this endpoint serves customers their own bookings, so
 * a field left in the payload is one devtools panel away no matter what the UI
 * renders.
 */

/** May this actor see the price schedule and what anyone was charged? */
export const pricingAppliesTo = (user) => hasPermission(user, PERMISSIONS.VIEW_PRICING);

/** Is this row's booking the reader's own? */
const ownedBy = (doc, user) =>
  Boolean(doc?.user) && Boolean(user?._id) && String(doc.user) === String(user._id);

// COPY, then delete — a `.lean()` query hands back plain objects, and editing
// those in place would edit the caller's data.
const redact = (doc, user) => {
  if (!doc || typeof doc !== 'object') return doc;

  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };

  // Internal, always: which schedule was used, and who applied it.
  delete o.priceType;
  delete o.pricedAt;
  delete o.pricedBy;

  // The rate itself survives only on the reader's own raised PO.
  if (!isPoGenerated(o) || !ownedBy(o, user)) delete o.unitPrice;

  return o;
};

/**
 * Redact pricing on an order row, or an array of them, for this viewer.
 *
 * Ownership is re-derived from the row rather than assumed from the endpoint.
 * getOrders() already filters a plain customer to their own bookings, so for
 * them the test is redundant — and that is the point: it stays correct if a
 * future caller passes rows it has scoped some other way.
 */
export const withPricingVisibility = (docs, user) => {
  if (pricingAppliesTo(user)) return docs;
  return Array.isArray(docs) ? docs.map((d) => redact(d, user)) : redact(docs, user);
};

export default { pricingAppliesTo, withPricingVisibility };
